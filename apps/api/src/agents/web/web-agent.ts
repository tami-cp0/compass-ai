import OpenAI from 'openai';
import type { WebAgentStep, StepRecord } from '@compass-ai/types';
import { logger } from '../../infra/logger.js';
import type { TokenUsage } from '../../infra/token-tracker.js';
import { SYSTEM_PROMPT, WEB_AGENT_SCHEMA } from './web-config.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const _dir = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = join(_dir, '..', '..', '..', 'logs');

if (!process.env.OPENAI_API_KEY) {
	throw new Error('OPENAI_API_KEY environment variable is not set');
}

if (!process.env.OPENAI_VECTOR_STORE_ID) {
	throw new Error('OPENAI_VECTOR_STORE_ID environment variable is not set');
}

if (!process.env.OPENAI_WEB_MODEL) {
	throw new Error('OPENAI_WEB_MODEL environment variable is not set');
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const VECTOR_STORE_ID = process.env.OPENAI_VECTOR_STORE_ID;

function buildHistoryText(history: StepRecord[]): string {
	if (history.length === 0) return '';
	return (
		'Recent steps:\n' +
		history
			.map((s) => {
				const base = `Step ${s.step_number}: ${s.action_description} → ${s.outcome}`;
				return s.outcome === 'failed' && s.error
					? `${base} (${s.error})`
					: base;
			})
			.join('\n') +
		'\n\n'
	);
}

export async function webAgentNextStep(
	task: string,
	elementMap: string,
	screenshot: string,
	history: StepRecord[]
): Promise<{ step: WebAgentStep; usage: TokenUsage }> {
	const historyText = buildHistoryText(history);
	const stepNumber = history.length + 1;

	try {
		mkdirSync(LOGS_DIR, { recursive: true });
		const base64Data = screenshot.replace(/^data:image\/\w+;base64,/, "");
		const buffer = Buffer.from(base64Data, 'base64');
		const filename = `debug_screenshot_${Date.now()}_step${stepNumber}.png`;
		writeFileSync(join(LOGS_DIR, filename), buffer);
		logger.info(`[compass] Saved debug screenshot to ${filename}`);
	} catch (e) {
		logger.error('[compass] Failed to save debug screenshot', { err: e instanceof Error ? e.message : String(e) });
	}

	logger.info(`[compass] Executing WebAgent Step ${stepNumber} for task: ${task.slice(0, 100)}...`);
	logger.info(`[compass] Element map contains ${elementMap.split('\n').length} lines`);

	const response = await openai.responses.create({
		model: process.env.OPENAI_WEB_MODEL!,
		tools: [{ type: 'file_search', vector_store_ids: [VECTOR_STORE_ID] }],
		input: [
			{ role: 'system', content: SYSTEM_PROMPT },
			{
				role: 'user',
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				content: [
					{
						type: 'input_text',
						text: `${historyText}Task: ${task}\n\nCurrent page:`,
					},
					{
						type: 'input_image',
						image_url: screenshot,
						detail: 'high',
					},
					{
						type: 'input_text',
						text: `Elements (only these IDs are valid):\n${elementMap}`,
					},
				] as any,
			},
		],
		max_output_tokens: 800,
		text: { format: WEB_AGENT_SCHEMA },
	});

	const lastMessageBlock = response.output
		.filter((block) => block.type === 'message')
		.pop();

	const outputText = lastMessageBlock && lastMessageBlock.type === 'message'
		? lastMessageBlock.content
				.filter((c): c is Extract<typeof c, { type: 'output_text' }> => c.type === 'output_text')
				.map((c) => c.text)
				.join('')
		: '';

	logger.info(`[compass] WebAgent raw output: ${outputText}`);

	if (!outputText) throw new Error('WebAgent returned empty output');

	let parsed: WebAgentStep;
	try {
		parsed = JSON.parse(outputText) as WebAgentStep;
	} catch {
		throw new Error(
			`WebAgent returned unparseable JSON: ${outputText.slice(0, 200)}`
		);
	}

	logger.debug('WebAgent step planned', {
		stepNumber: history.length + 1,
		isComplete: parsed.is_complete,
		isFailed: parsed.is_failed,
		action: parsed.next_action?.action,
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
