import Anthropic from '@anthropic-ai/sdk';
import type { AgentAction, ScrollRegion } from '@compass-ai/types';
import { logger } from '../../infra/logger.js';
import type { TokenUsage } from '../../infra/token-tracker.js';
import { SYSTEM_PROMPT } from './web-prompt.js';
import { mapToolUse, TOOLS, type MappedStep } from './web-tools.js';
import type { WebAgentMemory } from './web-memory.js';

if (!process.env.CLAUDE_API_KEY) {
	throw new Error('CLAUDE_API_KEY environment variable is not set');
}
if (!process.env.CLAUDE_WEB_MODEL) {
	throw new Error('CLAUDE_WEB_MODEL environment variable is not set');
}

const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

const COMPUTER_BETA = 'computer-use-2025-11-24';

// How many of the most-recent screenshots to keep in the message history. The
// model acts on the latest frame; older ones are replaced with a text stub to
// keep per-step input tokens flat instead of growing every turn.
const SCREENSHOTS_TO_KEEP = 2;

export interface WebObservation {
	// data URL or raw base64 of the current screenshot.
	screenshot: string;
	// Image dimensions — the space the model's coordinates come back in.
	width: number;
	height: number;
	// CSS viewport dimensions — the space CDP dispatch and DOM reads expect.
	// When these differ from width/height, coords are scaled before execution.
	cssWidth: number;
	cssHeight: number;
	url: string;
	title: string;
	scrollRegions?: ScrollRegion[];
	// Results of the actions the model emitted last turn — one per tool_use id,
	// so the model sees whether each landed. Empty on the first step.
	actionResults?: Array<{ toolUseId: string; ok: boolean; error?: string; text?: string }>;
}

// The step the orchestrator consumes. Mirrors the old AgentStep shape so the
// task-manager loop is unchanged: reasoning (assistant narration), a
// progress_note for the externalized log, and the ordered actions to run.
export interface WebStep {
	reasoning: string;
	progress_note: string;
	actions: AgentAction[];
	// Per-action tool_use ids so the next observation can answer each with a
	// tool_result. Aligned index-wise with `actions`.
	toolUseIds: string[];
	// tool_use ids that produced no action but still need a tool_result.
	noopToolUseIds: string[];
	terminal: MappedStep['terminal'];
}

// Transient network errors worth a retry.
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);
function isRetryable(err: unknown): boolean {
	if (err && typeof err === 'object') {
		const status = (err as { status?: number }).status;
		if (typeof status === 'number' && RETRYABLE_STATUS.has(status)) return true;
	}
	const msg = err instanceof Error ? err.message : String(err);
	return ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'socket hang up', 'fetch failed'].some(
		(s) => msg.includes(s)
	);
}

async function withRetry<T>(fn: () => Promise<T>, retries = 3, delayMs = 1000): Promise<T> {
	let lastErr: unknown;
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			return await fn();
		} catch (err) {
			lastErr = err;
			if (!isRetryable(err) || attempt === retries) throw err;
			logger.warn('[compass] Retrying WebAgent step', {
				attempt: attempt + 1,
				error: err instanceof Error ? err.message : String(err),
			});
			await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
		}
	}
	throw lastErr;
}

function toBase64(screenshot: string): string {
	return screenshot.startsWith('data:') ? screenshot.split(',', 2)[1] ?? '' : screenshot;
}

// Scroll regions come from the DOM in CSS pixels; the model reads the image in
// image pixels. Scale the boxes into image space so they line up with what it
// sees. `s` = image px per CSS px.
function renderScrollRegions(regions: ScrollRegion[] | undefined, s: number): string {
	if (!regions || regions.length === 0) {
		return 'Scrollable regions: NONE on screen — nothing here scrolls; do not scroll.';
	}
	const px = (n: number) => Math.round(n * s);
	const lines = regions.map((r) => {
		const dirs = [
			r.canScrollDown ? 'down' : null,
			r.canScrollUp ? 'up' : null,
			r.canScrollLeft ? 'left' : null,
			r.canScrollRight ? 'right' : null,
		].filter(Boolean);
		const can = dirs.length ? `can scroll ${dirs.join('/')}` : 'AT LIMIT — cannot scroll further';
		return `- ${r.label ? `"${r.label}" ` : ''}(${px(r.x)},${px(r.y)}) ${px(r.width)}×${px(r.height)}: ${can}`;
	});
	return `Scrollable regions (scroll only inside one that "can scroll" the direction you need):\n${lines.join('\n')}`;
}

// Build the user-turn content for the current observation.
// First step → a fresh user message (goal + screenshot). Later steps → the
// tool_result blocks answering last turn's tool_use ids, each carrying context;
// the final one embeds the new screenshot.
function buildObservationContent(
	memory: WebAgentMemory,
	obs: WebObservation,
	firstStep: boolean
): Anthropic.Beta.BetaContentBlockParam[] {
	const s = obs.cssWidth > 0 ? obs.width / obs.cssWidth : 1;
	const context =
		`Current tab — ${obs.title || '(untitled)'} — ${obs.url}\n` +
		`Screenshot: ${obs.width} × ${obs.height} px (all coordinates are in this image space).\n` +
		renderScrollRegions(obs.scrollRegions, s) +
		(memory.noProgressStreak >= 2
			? `\n\nNOTICE: your last ${memory.noProgressStreak} pointer actions repeated the same spot with no effect — that element is not responding. Stop targeting it; take a different route (another control, the sidebar, or scroll).`
			: '');

	const imageBlock: Anthropic.Beta.BetaImageBlockParam = {
		type: 'image',
		source: { type: 'base64', media_type: 'image/png', data: toBase64(obs.screenshot) },
	};

	const results = obs.actionResults ?? [];

	// First turn, or a turn where the model emitted no tool_use (pure text) — no
	// tool_results are owed, so send a plain observation.
	if (firstStep || results.length === 0) {
		return [
			{ type: 'text', text: `${firstStep ? `Task: ${memory.goal}\n\n` : ''}${context}\n\nCurrent screen:` },
			imageBlock,
		];
	}

	// Answer each prior tool_use with a tool_result (text only — an is_error
	// result may NOT contain an image, per the API). The fresh screenshot +
	// context then ride on the LAST non-error result, or, if every result is an
	// error, as a separate image block appended after the tool_results.
	const blocks: Anthropic.Beta.BetaContentBlockParam[] = [];
	const lastOkIdx = results.map((r) => r.ok).lastIndexOf(true);
	results.forEach((r, i) => {
		const content: Anthropic.Beta.BetaToolResultBlockParam['content'] = [];
		if (r.text !== undefined) {
			content.push({ type: 'text', text: r.text || '(nothing visible in box)' });
		} else if (r.error) {
			content.push({ type: 'text', text: `Failed: ${r.error}` });
		}
		if (i === lastOkIdx) {
			content.push({ type: 'text', text: context });
			content.push(imageBlock);
		}
		blocks.push({
			type: 'tool_result',
			tool_use_id: r.toolUseId,
			is_error: !r.ok,
			content: content.length ? content : 'ok',
		});
	});

	// Every result was an error → the frame couldn't attach to any of them.
	// Append it as a standalone block after the tool_results (valid in the same
	// user turn) so the model still sees the current screen.
	if (lastOkIdx === -1) {
		blocks.push({ type: 'text', text: context });
		blocks.push(imageBlock);
	}
	return blocks;
}

// Replace screenshot images in all but the most recent `keep` user turns with a
// short text stub, in place. Once an old image is stubbed it stays stubbed, so
// the history never re-grows. Walks newest → oldest counting image-bearing
// turns; stubs everything past the keep window.
function pruneOldScreenshots(messages: Anthropic.Beta.BetaMessageParam[], keep: number): void {
	let seen = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;

		const hasImage = msg.content.some(
			(b) =>
				b.type === 'image' ||
				(b.type === 'tool_result' &&
					Array.isArray(b.content) &&
					b.content.some((c) => c.type === 'image'))
		);
		if (!hasImage) continue;

		seen++;
		if (seen <= keep) continue;

		// Past the window — strip images from this turn.
		msg.content = msg.content.map((b) => {
			if (b.type === 'image') {
				return { type: 'text', text: '[earlier screenshot omitted]' };
			}
			if (b.type === 'tool_result' && Array.isArray(b.content)) {
				return {
					...b,
					content: b.content.map((c) =>
						c.type === 'image' ? { type: 'text', text: '[earlier screenshot omitted]' } : c
					),
				};
			}
			return b;
		});
	}
}

export async function runWebAgentStep(
	memory: WebAgentMemory,
	observation: WebObservation
): Promise<{ step: WebStep; usage: TokenUsage }> {
	const stepNumber = memory.stepCount + 1;
	logger.info(
		`[compass] WebAgent step ${stepNumber} — goal: ${memory.goal.slice(0, 100)} — url: ${observation.url}`
	);

	const firstStep = memory.messages.length === 0;
	memory.messages.push({
		role: 'user',
		content: buildObservationContent(memory, observation, firstStep),
	});

	// Screenshots dominate input tokens and accumulate every turn. The model
	// only needs the latest frame to act, so strip images from older turns —
	// this flattens the per-step token climb from linear to roughly constant.
	pruneOldScreenshots(memory.messages, SCREENSHOTS_TO_KEEP);

	const response = await withRetry(() =>
		anthropic.beta.messages.create({
			model: process.env.CLAUDE_WEB_MODEL!,
			max_tokens: 1500,
			// Low reasoning effort. On computer-use UI tasks Anthropic notes low
			// can even use fewer output tokens than disabling thinking (fewer
			// mistakes → fewer retries), and it's faster per step.
			output_config: { effort: 'low' },
			// Cache the stable prefix (system prompt + tool defs) so it bills at
			// ~10% on every step after the first instead of full rate.
			system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
			tools: TOOLS(observation.width, observation.height),
			betas: [COMPUTER_BETA],
			messages: memory.messages,
		})
	);

	// Record the assistant turn verbatim so the conversation stays valid.
	memory.messages.push({ role: 'assistant', content: response.content });

	const text = response.content
		.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
		.map((b) => b.text)
		.join(' ')
		.trim();

	const mapped = mapToolUse(response.content);
	logger.info(`[compass] WebAgent step ${stepNumber}: ${text || '(no text)'} — actions: ${mapped.actions.map((a) => a.variant).join(', ') || 'none'}`);

	const step: WebStep = {
		reasoning: text,
		progress_note: text || mapped.actions.map((a) => a.variant).join(', ') || 'no action',
		actions: mapped.actions,
		toolUseIds: mapped.toolUseIds,
		noopToolUseIds: mapped.noopToolUseIds,
		terminal: mapped.terminal,
	};

	const u = response.usage;
	const usage: TokenUsage = {
		inputTokens: u.input_tokens,
		outputTokens: u.output_tokens,
		totalTokens: u.input_tokens + u.output_tokens,
		cachedTokens: u.cache_read_input_tokens ?? undefined,
	};

	return { step, usage };
}
