import OpenAI from 'openai';
import type { AgentAction, AgentStep, ScrollRegion } from '@compass-ai/types';
import { logger } from '../../infra/logger.js';
import type { TokenUsage } from '../../infra/token-tracker.js';
import { SYSTEM_PROMPT } from './web-prompt.js';
import { WEB_AGENT_STEP_SCHEMA } from './web-actions.js';
import type { WebAgentMemory } from './web-memory.js';

if (!process.env.OPENAI_API_KEY) {
	throw new Error('OPENAI_API_KEY environment variable is not set');
}

if (!process.env.OPENAI_WEB_MODEL) {
	throw new Error('OPENAI_WEB_MODEL environment variable is not set');
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Transient OpenAI errors we'll retry. Mirrors pear's retry_on_partial_message
// pattern. Match against substring of err.message or err.status.
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);
const RETRYABLE_SUBSTRINGS = [
	'ECONNRESET',
	'ETIMEDOUT',
	'ENOTFOUND',
	'EAI_AGAIN',
	'socket hang up',
	'fetch failed',
	'No actions generated',
	'unparseable JSON',
];

interface RetryOptions {
	retries: number;
	delayMs: number;
}

function isRetryable(err: unknown): boolean {
	if (err && typeof err === 'object') {
		const status = (err as { status?: number }).status;
		if (typeof status === 'number' && RETRYABLE_STATUS.has(status)) return true;
	}
	const msg = err instanceof Error ? err.message : String(err);
	return RETRYABLE_SUBSTRINGS.some((s) => msg.includes(s));
}

async function retryTransient<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
	let lastErr: unknown;
	for (let attempt = 0; attempt <= opts.retries; attempt++) {
		try {
			return await fn();
		} catch (err) {
			lastErr = err;
			if (!isRetryable(err) || attempt === opts.retries) throw err;
			logger.warn('[compass] Retrying WebAgent step', {
				attempt: attempt + 1,
				maxRetries: opts.retries,
				error: err instanceof Error ? err.message : String(err),
			});
			await new Promise((r) => setTimeout(r, opts.delayMs * (attempt + 1)));
		}
	}
	throw lastErr;
}

export interface WebObservation {
	// data URL or raw base64 of the current screenshot, CSS-pixel sized
	screenshot: string;
	width: number;
	height: number;
	url: string;
	title: string;
	scrollRegions?: ScrollRegion[];
}

// Deterministic scroll affordances for the current viewport — the agent must
// consult these BEFORE scrolling, so it never scrolls a region that cannot move.
function renderScrollRegions(regions?: ScrollRegion[]): string {
	if (!regions || regions.length === 0) {
		return 'Scrollable regions: NONE detected on screen — nothing here scrolls; do not emit mouse:scroll.';
	}
	const lines = regions.map((r) => {
		const dirs = [
			r.canScrollDown ? 'down' : null,
			r.canScrollUp ? 'up' : null,
			r.canScrollLeft ? 'left' : null,
			r.canScrollRight ? 'right' : null,
		].filter(Boolean);
		const where = `(${r.x},${r.y}) ${r.width}×${r.height}`;
		const name = r.label ? `"${r.label}" ` : '';
		const can = dirs.length ? `can scroll ${dirs.join('/')}` : 'AT LIMIT — cannot scroll further';
		return `- ${name}${where}: ${can}`;
	});
	return `Scrollable regions (scroll only inside one that "can scroll" the direction you need — target a coordinate inside its box):\n${lines.join('\n')}`;
}

export async function runWebAgentStep(
	memory: WebAgentMemory,
	observation: WebObservation
): Promise<{ step: AgentStep; usage: TokenUsage }> {
	const stepNumber = memory.stepCount + 1;

	logger.info(
		`[compass] WebAgent step ${stepNumber} — goal: ${memory.goal.slice(0, 100)} — url: ${observation.url}`
	);

	const screenshotDataUrl = observation.screenshot.startsWith('data:')
		? observation.screenshot
		: `data:image/png;base64,${observation.screenshot}`;

	const historyText = memory.renderRecentHistory();
	const lastResults = memory.lastResults();

	const userBlocks: Array<{ type: 'input_text'; text: string } | { type: 'input_image'; image_url: string; detail: 'high' }> = [];

	let header = `Task: ${memory.goal}`;
	header += `\n\nCurrent tab — title: ${observation.title || '(untitled)'} — url: ${observation.url}`;
	header += `\nScreenshot dimensions: ${observation.width} × ${observation.height} (CSS pixels). All coordinates you emit must be in this space.`;
	header += `\n\n${renderScrollRegions(observation.scrollRegions)}`;
	if (historyText) {
		header += `\n\nRecent history (oldest → newest):\n${historyText}`;
	}
	if (lastResults && lastResults.length > 0) {
		const lines = lastResults.map(
			(r) =>
				`- ${r.variant}: ${r.result}${r.error ? ` (${r.error})` : ''}` +
				(r.data !== undefined ? `\n  text read: ${r.data || '(nothing visible in box)'}` : '')
		);
		header += `\n\nResults of the previous batch:\n${lines.join('\n')}`;
	} else if (stepNumber === 1) {
		header += `\n\nThis is the first turn. No prior actions have been taken.`;
	}
	const notice = memory.noProgressNotice();
	if (notice) {
		header += `\n\n${notice}`;
	}
	header += `\n\nCurrent screenshot:`;

	userBlocks.push({ type: 'input_text', text: header });
	userBlocks.push({ type: 'input_image', image_url: screenshotDataUrl, detail: 'high' });

	const { parsed, response } = await retryTransient(
		async () => {
			const response = await openai.responses.create({
				model: process.env.OPENAI_WEB_MODEL!,
				input: [
					{ role: 'system', content: SYSTEM_PROMPT },
					{
						role: 'user',
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						content: userBlocks as any,
					},
				],
				max_output_tokens: 1500,
				text: { format: WEB_AGENT_STEP_SCHEMA },
			});

			const lastMessageBlock = response.output
				.filter((block) => block.type === 'message')
				.pop();

			const outputText =
				lastMessageBlock && lastMessageBlock.type === 'message'
					? lastMessageBlock.content
							.filter((c): c is Extract<typeof c, { type: 'output_text' }> => c.type === 'output_text')
							.map((c) => c.text)
							.join('')
					: '';

			logger.info(`[compass] WebAgent raw output: ${outputText}`);

			if (!outputText) throw new Error('WebAgent returned empty output');

			let parsed: AgentStep;
			try {
				parsed = JSON.parse(outputText) as AgentStep;
			} catch {
				throw new Error(`WebAgent returned unparseable JSON: ${outputText.slice(0, 200)}`);
			}

			if (!Array.isArray(parsed.actions) || parsed.actions.length === 0) {
				throw new Error('No actions generated');
			}

			return { parsed, response };
		},
		{ retries: 3, delayMs: 1000 }
	);

	logger.debug('WebAgent step planned', {
		stepNumber,
		actionCount: parsed.actions.length,
		variants: parsed.actions.map((a: AgentAction) => a.variant),
	});

	const u = response.usage;
	const usage: TokenUsage = {
		inputTokens: u?.input_tokens ?? 0,
		outputTokens: u?.output_tokens ?? 0,
		totalTokens: u?.total_tokens ?? 0,
		cachedTokens: u?.input_tokens_details?.cached_tokens,
	};

	return { step: parsed, usage };
}
