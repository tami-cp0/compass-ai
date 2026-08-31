import { ThinkingLevel, type GoogleGenAI } from '@google/genai';
import { logger } from '../../infra/logger.js';
import type { TokenUsage } from '../../infra/token-tracker.js';
import {
	buildTriagePrompt,
	buildDeepResearchPrompt,
	ESCALATE_SENTINEL,
} from './agent-config.js';

// A primary source worth handing to the user: the page the research centres
// on. Derived from the response's grounding metadata, not a model-authored
// field — so it reflects what was actually retrieved.
export interface ResearchSource {
	url: string;
	title: string;
	platform: string;
}

export interface ResearchOutput {
	// Grounded prose answer. Depth follows the evidence (see the prompts): a line
	// for a plain fact from the fast lane, several paragraphs for a causal
	// question from the deep lane.
	answer: string;
	sources: ResearchSource[];
	// Which lane produced the answer — 'fast' (Flash-Lite triage) or 'deep'
	// (Flash 3.6, escalated). For logging/accounting; not shown to the user.
	tier: 'fast' | 'deep';
}

// Africa/Lagos date parts for the prompt's temporal anchor — the whole app is
// WAT (user + NGX), so no conversion is needed at the model layer.
const DATE_FMT = new Intl.DateTimeFormat('en-GB', {
	timeZone: 'Africa/Lagos',
	weekday: 'long',
	day: 'numeric',
	month: 'long',
	year: 'numeric',
});

function currentDateParts(): { currentDate: string; dayOfWeek: string } {
	const parts = DATE_FMT.formatToParts(new Date());
	const get = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((p) => p.type === type)?.value ?? '';
	const dayOfWeek = get('weekday');
	const currentDate = `${get('day')} ${get('month')} ${get('year')}`;
	return { currentDate, dayOfWeek };
}

// Pull primary sources from the response's grounding metadata. Google Search
// grounding returns groundingChunks[].web.{uri,title,domain}; that's the real
// list of retrieved pages, which is why we take sources from here rather than
// asking the model to author them (and why we don't force a JSON schema — a
// schema and grounding fight each other on this model).
//
// We deliberately read ONLY groundingChunks, not urlContextMetadata. Pages the
// model opens via urlContext were found through its own search first, so they
// already appear here WITH a title and domain; urlContextMetadata carries only
// a bare URL (no title/platform), which would make a worse source bar. Discovery
// is search — there are no user-supplied URLs in the query — so the miss window
// is negligible and not worth degrading source quality for.
function extractSources(response: unknown): ResearchSource[] {
	const candidate = (response as {
		candidates?: Array<{
			groundingMetadata?: {
				groundingChunks?: Array<{
					web?: { uri?: string; title?: string; domain?: string };
				}>;
			};
		}>;
	}).candidates?.[0];
	const chunks = candidate?.groundingMetadata?.groundingChunks ?? [];

	const seen = new Set<string>();
	const sources: ResearchSource[] = [];
	for (const chunk of chunks) {
		const url = chunk.web?.uri;
		if (!url || seen.has(url)) continue;
		seen.add(url);
		sources.push({
			url,
			title: chunk.web?.title ?? url,
			platform: chunk.web?.domain ?? '',
		});
		if (sources.length >= 5) break;
	}
	return sources;
}

// usageMetadata → our TokenUsage. Used for both lanes; summed when we escalate.
function usageOf(response: unknown): TokenUsage {
	const u = (response as { usageMetadata?: {
		promptTokenCount?: number;
		candidatesTokenCount?: number;
		totalTokenCount?: number;
		cachedContentTokenCount?: number;
	} }).usageMetadata;
	return {
		inputTokens: u?.promptTokenCount ?? 0,
		outputTokens: u?.candidatesTokenCount ?? 0,
		totalTokens: u?.totalTokenCount ?? 0,
		cachedTokens: u?.cachedContentTokenCount,
	};
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
	return {
		inputTokens: a.inputTokens + b.inputTokens,
		outputTokens: a.outputTokens + b.outputTokens,
		totalTokens: a.totalTokens + b.totalTokens,
		cachedTokens: (a.cachedTokens ?? 0) + (b.cachedTokens ?? 0),
	};
}

// Two-tier research. The fast lane (Flash-Lite) triages every query: it answers
// simple lookups from snippets, or emits the escalation sentinel. On escalation
// we run the deep lane (Flash 3.6 + urlContext + HIGH thinking) fresh. Token
// usage is summed across both calls so accounting reflects the true cost.
export async function runResearchAgent(
	ai: GoogleGenAI,
	description: string,
	signal?: AbortSignal
): Promise<{ result: ResearchOutput; usage: TokenUsage }> {
	const { currentDate, dayOfWeek } = currentDateParts();

	// ── Fast lane / triage (Flash-Lite, search only, LOW thinking) ──
	const fastResponse = await ai.models.generateContent({
		model: process.env.GEMINI_RESEARCH_FAST_MODEL!,
		contents: `Research query: ${description}`,
		config: {
			systemInstruction: buildTriagePrompt(currentDate, dayOfWeek),
			tools: [{ googleSearch: {} }],
			maxOutputTokens: 800,
			thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
			...(signal ? { abortSignal: signal } : {}),
		},
	});
	const fastUsage = usageOf(fastResponse);
	const fastText = (fastResponse.text ?? '').trim();

	// Escalate when the sentinel is present. We check `includes` (not strict
	// equality) so a stray token around it still routes correctly; the deep
	// lane then re-answers from scratch, so the fast text is discarded.
	if (!fastText.includes(ESCALATE_SENTINEL)) {
		if (!fastText) throw new Error('ResearchAgent (fast lane) returned empty output');
		const result: ResearchOutput = {
			answer: fastText,
			sources: extractSources(fastResponse),
			tier: 'fast',
		};
		logger.debug('ResearchAgent fast lane answered', {
			model: process.env.GEMINI_RESEARCH_FAST_MODEL,
			sources: result.sources.length,
		});
		return { result, usage: fastUsage };
	}

	// ── Deep lane (Flash 3.6, search + urlContext, HIGH thinking) ──
	logger.debug('ResearchAgent escalating to deep lane', { description: description.slice(0, 120) });
	const deepResponse = await ai.models.generateContent({
		model: process.env.GEMINI_RESEARCH_DEEP_MODEL!,
		contents: `Research query: ${description}`,
		config: {
			systemInstruction: buildDeepResearchPrompt(currentDate, dayOfWeek),
			// googleSearch finds candidate pages (snippets); urlContext lets the
			// model actually OPEN and read them in full — which the prompt's
			// "READING, NOT SKIMMING" rules require. Snippets alone can't satisfy
			// "read the tables, the notes and the fine print before quoting".
			tools: [{ googleSearch: {} }, { urlContext: {} }],
			maxOutputTokens: 4000,
			thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
			...(signal ? { abortSignal: signal } : {}),
		},
	});
	const usage = addUsage(fastUsage, usageOf(deepResponse));
	const answer = (deepResponse.text ?? '').trim();
	if (!answer) throw new Error('ResearchAgent (deep lane) returned empty output');

	const result: ResearchOutput = {
		answer,
		sources: extractSources(deepResponse),
		tier: 'deep',
	};
	logger.debug('ResearchAgent deep lane completed', {
		model: process.env.GEMINI_RESEARCH_DEEP_MODEL,
		sources: result.sources.length,
	});
	return { result, usage };
}
