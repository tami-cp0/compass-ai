import { logger } from '../../infra/logger.js';
import { buildSystemPrompt, openai } from './agent-config.js';
export interface TemporalValidation {
	data_as_of_date: string;
	most_recent_quarter_analyzed: string;
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
): Promise<ResearchOutput> {
	const today = new Date().toISOString().slice(0, 10);
	const userMessage = context
		? `Conversation context:\n${context}\n\nResearch query: ${description}`
		: `Research query: ${description}`;

	const response = await openai.responses.create(
		{
			model: 'gpt-5.4-mini',
			tools: [{ type: 'web_search' }],
			input: [
				{ role: 'system', content: buildSystemPrompt(today) },
				{ role: 'user', content: userMessage },
			],
      max_output_tokens: 4000, // output tokens + reasoning tokens
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
			`ResearchAgent returned unparseable JSON: ${outputText.slice(
				0,
				200
			)}`
		);
	}
	logger.info('ResearchAgent completed', {
		description,
		themes: parsed.dynamic_context.identified_themes,
	});
	return parsed;
}
