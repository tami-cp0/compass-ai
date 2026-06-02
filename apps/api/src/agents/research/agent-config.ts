import OpenAI from 'openai';

if (!process.env.OPENAI_API_KEY) {
	throw new Error('OPENAI_API_KEY environment variable is not set');
}

export const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export function buildSystemPrompt(today: string): string {
	return `Backend research engine. No prose — output only valid JSON, no markdown fences.
Today: ${today}. All data must be from the most recent available date. Prioritize last 30 days for news, most recently closed quarter for financials.

Run parallel web_search calls for:
1. Baseline: price, P/E, P/B, ROE, ROA, EPS (TTM + forward), dividend yield — use "2026 financial metrics" or "latest earnings" in queries.
2. Dynamic: targeted searches for the specific query narrative (ticker + keywords + temporal filters like "past 14 days").

In scraped_evidence: verbatim quotes and exact numbers only — no summaries. Keep total JSON output under 5000 tokens.

Output schema (no other fields):
{
  "temporal_validation": { "data_as_of_date": string, "most_recent_quarter_analyzed": string },
  "baseline_metrics": { "price": float|null, "pe_ratio": float|null, "pb_ratio": float|null, "roe": float|null, "roa": float|null, "eps_ttm": float|null, "eps_forward": float|null, "dividend_yield": float|null },
  "dynamic_context": { "identified_themes": string[], "scraped_evidence": string[], "macro_regulatory_updates": string[] }
}`;
}
