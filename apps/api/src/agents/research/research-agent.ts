import { logger } from '../../infra/logger.js';
import type { TokenUsage } from '../../infra/token-tracker.js';
import { buildStockAnalysisPrompt, buildGeneralResearchPrompt, openai } from './agent-config.js';

export interface TemporalValidation {
	data_as_of_date: string;
	most_recent_quarter_analyzed: string;
	metric_period_used: string | null;
}

export interface BaselineMetrics {
	price: number | null;
	pe_ratio: number | null;
	pb_ratio: number | null;
	roe: number | null;
	roa: number | null;
	eps_ttm: number | null;
	eps_forward: number | null;
	dividend_yield: number | null;
	market_cap: number | null;
	revenue_growth: number | null;
	debt_to_equity: number | null;
}

export interface MetricKeyValuePair {
	metric_name: string;
	metric_value: string;
}

export interface DynamicContext {
	identified_themes: string[];
	scraped_evidence: string[];
	macro_regulatory_updates: string[];
}

export interface StockAnalysisOutput {
	temporal_validation: TemporalValidation;
	baseline_metrics: BaselineMetrics;
	additional_metrics: MetricKeyValuePair[];
	dynamic_context: DynamicContext;
}

export interface GeneralResearchOutput {
	identified_themes: string[];
	scraped_evidence: string[];
	sources: string[];
}

export type ResearchOutput = StockAnalysisOutput | GeneralResearchOutput;

const stockAnalysisSchema = {
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
				market_cap: { type: ['number', 'null'] },
				revenue_growth: { type: ['number', 'null'] },
				debt_to_equity: { type: ['number', 'null'] },
			},
			required: [
				'price',
				'pe_ratio',
				'pb_ratio',
				'roe',
				'roa',
				'eps_ttm',
				'eps_forward',
				'dividend_yield',
				'market_cap',
				'revenue_growth',
				'debt_to_equity',
			],
			additionalProperties: false,
		},
		additional_metrics: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					metric_name: { type: 'string' },
					metric_value: { type: 'string' },
				},
				required: ['metric_name', 'metric_value'],
				additionalProperties: false,
			},
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
	required: ['temporal_validation', 'baseline_metrics', 'additional_metrics', 'dynamic_context'],
	additionalProperties: false,
};

const generalResearchSchema = {
	type: 'object',
	properties: {
		identified_themes: { type: 'array', items: { type: 'string' } },
		scraped_evidence: { type: 'array', items: { type: 'string' } },
		sources: { type: 'array', items: { type: 'string' } },
	},
	required: ['identified_themes', 'scraped_evidence', 'sources'],
	additionalProperties: false,
};

export async function runResearchAgent(
	profile: 'stock_analysis' | 'general_research',
	description: string,
	signal?: AbortSignal
): Promise<{ result: ResearchOutput; usage: TokenUsage }> {
	const today = new Date().toISOString().slice(0, 10);
	const userMessage = `Research query: ${description}`;

	const model = profile === 'stock_analysis'
		? process.env.OPENAI_RESEARCH_MODEL!
		: process.env.OPENAI_ALT_RESEARCH_MODEL!;

	const systemPrompt = profile === 'stock_analysis'
		? buildStockAnalysisPrompt(today)
		: buildGeneralResearchPrompt(today);

	const schema = profile === 'stock_analysis'
		? stockAnalysisSchema
		: generalResearchSchema;

	const response = await openai.responses.create(
		{
			model,
			tools: [{ type: 'web_search' }],
			input: [
				{ role: 'system', content: systemPrompt },
				{ role: 'user', content: userMessage },
			],
			max_output_tokens: 4000,
			text: {
				format: {
					type: 'json_schema',
					name: 'research_output',
					strict: true,
					schema,
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
	
	const themesCount = 'identified_themes' in parsed 
		? parsed.identified_themes.length 
		: parsed.dynamic_context.identified_themes.length;

	logger.debug('ResearchAgent completed', {
		profile,
		model,
		themes: themesCount,
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
