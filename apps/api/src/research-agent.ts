import OpenAI from "openai"
import { logger } from "./logger.js"

if (!process.env.OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY environment variable is not set")
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

export interface TemporalValidation {
  data_as_of_date:             string
  most_recent_quarter_analyzed: string
}

export interface BaselineMetrics {
  price?:          number | null
  pe_ratio?:       number | null
  pb_ratio?:       number | null
  roe?:            number | null
  roa?:            number | null
  eps_ttm?:        number | null
  eps_forward?:    number | null
  dividend_yield?: number | null
}

export interface DynamicContext {
  identified_themes:        string[]
  scraped_evidence:         string[]
  macro_regulatory_updates: string[]
}

export interface ResearchOutput {
  user_original_query: string
  temporal_validation: TemporalValidation
  baseline_metrics:    BaselineMetrics
  dynamic_context:     DynamicContext
}

function buildSystemPrompt(today: string): string {
  return `[SYSTEM ROLE: DATA RESEARCH MICROSERVICE]
You are a backend research engine. You do not speak to end-users. Your sole purpose is to execute parallel web_search operations and compile a dense, highly structured JSON context document for a downstream synthesizer LLM.

[TEMPORAL ANCHOR]
Today's date is ${today}. ALL searches and extracted data MUST be strictly filtered for the most recent available data, prioritizing trailing 30-day news and the most recently closed financial quarter unless asked otherwise.

[EXECUTION MANDATE: SINGLE-TURN PARALLEL SEARCH]
Upon receiving a user query, you must immediately execute multiple concurrent web_search tool calls to satisfy BOTH the Baseline and the Dynamic contexts simultaneously:

1. THE IMMUTABLE BASELINE (Always fetch):
   - Execute searches for the target asset's current Market Price, P/E Ratio, P/B Ratio, ROE, ROA, EPS (TTM & Forward), and the most recent Declared Dividend/Yield.
   - Append "2026 financial metrics" or "latest earnings report" to these queries.

2. THE DYNAMIC CONTEXT (Tailored to the user query):
   - Analyze the specific query. Identify the core narrative (e.g., "CEO resignation", "new FX policy", "Q3 guidance").
   - Execute targeted searches combining the asset ticker, the specific narrative keywords, and temporal filters (e.g., "past 14 days", "current policy update").

[OUTPUT FORMAT CONSTRAINT]
Output ONLY a valid JSON object. No conversational text. No markdown fences.
In dynamic_context.scraped_evidence, DO NOT summarize. Dump generous verbatim raw text snippets, direct management quotes, and precise numerical data exactly as found. The downstream LLM requires this raw semantic density.

Output schema:
{
  "user_original_query": "<the description passed to you>",
  "temporal_validation": {
    "data_as_of_date": "<today's date>",
    "most_recent_quarter_analyzed": "<e.g. Q1 2026>"
  },
  "baseline_metrics": {
    "price": <float or null>,
    "pe_ratio": <float or null>,
    "pb_ratio": <float or null>,
    "roe": <float or null>,
    "roa": <float or null>,
    "eps_ttm": <float or null>,
    "eps_forward": <float or null>,
    "dividend_yield": <float or null>
  },
  "dynamic_context": {
    "identified_themes": ["<theme 1>", "<theme 2>"],
    "scraped_evidence": ["<RAW VERBATIM QUOTE 1>", "<RAW VERBATIM QUOTE 2>"],
    "macro_regulatory_updates": ["<any relevant central bank or regulatory news from last 30 days>"]
  }
}`
}

export async function runResearchAgent(
  description: string,
  context:     string,
  signal?:     AbortSignal,
): Promise<ResearchOutput> {
  const today  = new Date().toISOString().slice(0, 10)
  const userMessage = context
    ? `Conversation context:\n${context}\n\nResearch query: ${description}`
    : `Research query: ${description}`

  const response = await openai.responses.create(
    {
      model: "gpt-5.4-mini",
      tools: [{ type: "web_search" }],
      input: [
        { role: "system",  content: buildSystemPrompt(today) },
        { role: "user",    content: userMessage },
      ],
    },
    { signal },
  )

  // Extract the text output from the response
  const outputText = response.output
    .filter((block) => block.type === "message")
    .flatMap((block) => {
      if (block.type !== "message") return []
      return block.content
        .filter((c): c is Extract<typeof c, { type: "output_text" }> => c.type === "output_text")
        .map((c) => c.text)
    })
    .join("")

  if (!outputText) {
    throw new Error("ResearchAgent returned empty output")
  }

  let parsed: ResearchOutput
  try {
    parsed = JSON.parse(outputText) as ResearchOutput
  } catch {
    throw new Error(`ResearchAgent returned unparseable JSON: ${outputText.slice(0, 200)}`)
  }
  logger.info("ResearchAgent completed", { description, themes: parsed.dynamic_context.identified_themes })
  return parsed
}
