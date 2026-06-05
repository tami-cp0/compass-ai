import { logger } from '../../infra/logger.js';
import type { TokenUsage } from '../../infra/token-tracker.js';
import { buildSystemPrompt, openai } from './agent-config.js';
export interface TemporalValidation {
	data_as_of_date: string;
	most_recent_quarter_analyzed: string;
	metric_period_used: string | null;
}

export interface BaselineMetrics {
	price?: number | null;
	pe_ratio?: number | null;
	pb_ratio?: number | null;
	roe?: number | null;
	roa?: number | null;
	eps_ttm?: number | null;
	eps_forward?: number | null;
	dividend_yield?: number | null;
}

export interface DynamicContext {
	identified_themes: string[];
	scraped_evidence: string[];
	macro_regulatory_updates: string[];
}

export interface ResearchOutput {
	temporal_validation: TemporalValidation;
	baseline_metrics: BaselineMetrics;
	dynamic_context: DynamicContext;
}

export async function runResearchAgent(
	description: string,
	context: string,
	signal?: AbortSignal
): Promise<{ result: ResearchOutput; usage: TokenUsage }> {
	const today = new Date().toISOString().slice(0, 10);
	const userMessage = context
		? `Conversation context:\n${context}\n\nResearch query: ${description}`
		: `Research query: ${description}`;

	const response = await openai.responses.create(
		{
			model: process.env.OPENAI_RESEARCH_MODEL!,
			tools: [{ type: 'web_search' }],
			input: [
				{ role: 'system', content: buildSystemPrompt(today) },
				{ role: 'user', content: userMessage },
			],
			max_output_tokens: 4000,
			text: {
				format: {
					type: 'json_schema',
					name: 'research_output',
					strict: true,
					schema: {
						type: 'object',
						properties: {
							temporal_validation: {
								type: 'object',
								properties: {
									data_as_of_date: { type: 'string' },
									most_recent_quarter_analyzed: { type: 'string' },
									metric_period_used: { type: ['string', 'null'] },
								},
								required: ['data_as_of_date', 'most_recent_quarter_analyzed', 'metric_period_used'],
								additionalProperties: false,
							},
							baseline_metrics: {
								type: 'object',
								properties: {
									price: { type: ['number', 'null'] },
									pe_ratio: { type: ['number', 'null'] },
									pb_ratio: { type: ['number', 'null'] },
									roe: { type: ['number', 'null'] },
									roa: { type: ['number', 'null'] },
									eps_ttm: { type: ['number', 'null'] },
									eps_forward: { type: ['number', 'null'] },
									dividend_yield: { type: ['number', 'null'] },
								},
								required: ['price', 'pe_ratio', 'pb_ratio', 'roe', 'roa', 'eps_ttm', 'eps_forward', 'dividend_yield'],
								additionalProperties: false,
							},
							dynamic_context: {
								type: 'object',
								properties: {
									identified_themes: { type: 'array', items: { type: 'string' } },
									scraped_evidence: { type: 'array', items: { type: 'string' } },
									macro_regulatory_updates: { type: 'array', items: { type: 'string' } },
								},
								required: ['identified_themes', 'scraped_evidence', 'macro_regulatory_updates'],
								additionalProperties: false,
							},
						},
						required: ['temporal_validation', 'baseline_metrics', 'dynamic_context'],
						additionalProperties: false,
					},
				},
			},
		},
		{ signal }
	);

	// Extract the text output from the response
	const outputText = response.output
		.filter((block) => block.type === 'message')
		.flatMap((block) => {
			if (block.type !== 'message') return [];
			return block.content
				.filter(
					(c): c is Extract<typeof c, { type: 'output_text' }> =>
						c.type === 'output_text'
				)
				.map((c) => c.text);
		})
		.join('');

	if (!outputText) {
		throw new Error('ResearchAgent returned empty output');
	}

	let parsed: ResearchOutput;
	try {
		parsed = JSON.parse(outputText) as ResearchOutput;
	} catch {
		throw new Error(
			`ResearchAgent returned unparseable JSON: ${outputText.slice(0, 200)}`
		);
	}
	logger.debug('ResearchAgent completed', {
		themes: parsed.dynamic_context.identified_themes.length,
	});
	const u = response.usage;
	const usage: TokenUsage = {
		inputTokens: u?.input_tokens ?? 0,
		outputTokens: u?.output_tokens ?? 0,
		totalTokens: u?.total_tokens ?? 0,
		cachedTokens: u?.input_tokens_details?.cached_tokens,
	};
	return { result: parsed, usage };
}
