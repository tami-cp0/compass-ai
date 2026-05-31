# Phase 6 — Research Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the research half of the TaskManager so Gemini Live tool calls dispatch real GPT-4o + web_search research jobs and inject results back into the live session.

**Architecture:** `GeminiLiveSession` tool call handlers are wired to a new `TaskManager` class. Research jobs call the OpenAI Responses API directly (with `web_search` tool) using a hand-written prompt — BAML is used only for the output TypeScript types. Results are JSON-stringified and injected back into Gemini via `injectContent`.

**Tech Stack:** TypeScript, OpenAI SDK (`openai` ^6), uWebSockets.js, BAML 0.75 (types only), ioredis

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `apps/api/baml_src/research_agent.baml` | Rewrite | Define output types only — no function/client (those are bypassed) |
| `apps/api/src/research-agent.ts` | Create | Calls OpenAI Responses API with `web_search`, returns typed `ResearchOutput` |
| `apps/api/src/task-manager.ts` | Create | Manages research slots, AbortControllers, dispatches/cancels jobs |
| `apps/api/src/gemini-live-session.ts` | Modify | Update `dispatch_research` tool param descriptions + system prompt addition |
| `apps/api/src/server.ts` | Modify | Instantiate `TaskManager`, wire handler callbacks |

---

## Task 1: Rewrite `research_agent.baml` — types only

**Files:**
- Modify: `apps/api/baml_src/research_agent.baml`

The BAML file defines only the output type hierarchy. No `function` or `client` block — the actual API call is made in TypeScript directly.

- [ ] **Step 1: Replace the entire file content**

```baml
class TemporalValidation {
  data_as_of_date             string
  most_recent_quarter_analyzed string
}

class BaselineMetrics {
  price          float?
  pe_ratio       float?
  pb_ratio       float?
  roe            float?
  roa            float?
  eps_ttm        float?
  eps_forward    float?
  dividend_yield float?
}

class DynamicContext {
  identified_themes         string[]
  scraped_evidence          string[]
  macro_regulatory_updates  string[]
}

class ResearchOutput {
  user_original_query string
  temporal_validation TemporalValidation
  baseline_metrics    BaselineMetrics
  dynamic_context     DynamicContext
}
```

- [ ] **Step 2: Regenerate BAML types**

Run from `apps/api/`:
```bash
npx baml-cli generate --from baml_src
```

Expected: no errors, `baml_client/` updated. The `ResearchOutput`, `BaselineMetrics`, `DynamicContext`, `TemporalValidation` types are now importable from `@boundaryml/baml/..` or the generated baml client.

- [ ] **Step 3: Verify generated types exist**

```bash
grep -r "ResearchOutput" baml_client/
```

Expected: at least one `.ts` file contains `ResearchOutput`.

---

## Task 2: Create `research-agent.ts` — OpenAI Responses API caller

**Files:**
- Create: `apps/api/src/research-agent.ts`

This module builds the prompt, calls `openai.responses.create` with `web_search` enabled, parses the JSON response into `ResearchOutput`. It does not import from BAML client — it uses a locally defined interface that matches the BAML types exactly (BAML types are for codegen consumers; this is the source of truth at runtime).

- [ ] **Step 1: Create the file**

```typescript
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
      model: "gpt-4o-search-preview",
      tools: [{ type: "web_search_preview" }],
      input: [
        { role: "system",  content: buildSystemPrompt(today) },
        { role: "user",    content: userMessage },
      ],
    },
    { signal },
  )

  // Extract the text output from the response
  const outputText = response.output
    .filter((block: { type: string }) => block.type === "message")
    .flatMap((block: { content: Array<{ type: string; text: string }> }) =>
      block.content.filter((c) => c.type === "output_text").map((c) => c.text)
    )
    .join("")

  if (!outputText) {
    throw new Error("ResearchAgent returned empty output")
  }

  const parsed = JSON.parse(outputText) as ResearchOutput
  logger.info("ResearchAgent completed", { description, themes: parsed.dynamic_context.identified_themes })
  return parsed
}
```

- [ ] **Step 2: Typecheck**

Run from `apps/api/`:
```bash
npx tsc --noEmit
```

Expected: no errors. If `openai.responses` is not recognised, the installed version may predate the Responses API — check with `npm list openai`. Version must be ^6. If types are missing for `responses.create`, cast as needed or add `// @ts-expect-error` with a note.

---

## Task 3: Create `task-manager.ts`

**Files:**
- Create: `apps/api/src/task-manager.ts`

- [ ] **Step 1: Create the file**

```typescript
import { v4 as uuidv4 } from "uuid"
import type { SessionState, Task } from "@compass-ai/types"
import type { GeminiLiveSession } from "./gemini-live-session.js"
import { getConversationHistory } from "./redis.js"
import { runResearchAgent } from "./research-agent.js"
import { logger } from "./logger.js"

export class TaskManager {
  private session:          SessionState
  private gemini:           GeminiLiveSession
  private abortControllers: Map<string, AbortController> = new Map()

  constructor(session: SessionState, gemini: GeminiLiveSession) {
    this.session = session
    this.gemini  = gemini
  }

  dispatchResearch(name: string, description: string): Record<string, unknown> {
    const slotIndex = this.session.researchSlots.findIndex(s => s === null)
    if (slotIndex === -1) {
      return { status: "rejected", reason: "research_slots_full" }
    }

    const taskId = uuidv4()
    const task: Task = {
      taskId,
      type:        "research",
      name,
      description,
      status:      "running",
      startedAt:   Date.now(),
    }
    this.session.researchSlots[slotIndex] = task

    const controller = new AbortController()
    this.abortControllers.set(taskId, controller)

    this._runResearch(task, slotIndex, controller.signal)

    return { taskId, status: "dispatched" }
  }

  private _runResearch(task: Task, slotIndex: number, signal: AbortSignal): void {
    const { taskId, name, description } = task
    const sessionId = this.session.sessionId

    getConversationHistory(sessionId)
      .then((history) => {
        const context = history.recentTurns
          .slice(-3)
          .map(t => `${t.role === "user" ? "User" : "Compass"}: ${t.content}`)
          .join("\n")
        return runResearchAgent(description, context, signal)
      })
      .then((result) => {
        if (this.session.cancelledTasks.has(taskId)) {
          logger.info("Research result discarded — task was cancelled", { taskId })
          return
        }
        this.session.researchSlots[slotIndex] = null
        this.abortControllers.delete(taskId)
        this.gemini.injectContent(JSON.stringify(result))
        logger.info("Research result injected", { taskId, name })
      })
      .catch((err: unknown) => {
        if (this.session.cancelledTasks.has(taskId)) {
          logger.info("Research error discarded — task was cancelled", { taskId })
          return
        }
        this.session.researchSlots[slotIndex] = null
        this.abortControllers.delete(taskId)
        const message = err instanceof Error ? err.message : String(err)
        this.gemini.injectContent(`[research error] Task "${name}" failed: ${message}`)
        logger.error("Research task failed", { taskId, name, error: message })
      })
  }

  dispatchAutomation(_name: string, _description: string): Record<string, unknown> {
    return { status: "rejected", reason: "automation_not_implemented" }
  }

  cancel(taskId: string): Record<string, unknown> {
    this.session.cancelledTasks.add(taskId)
    this.abortControllers.get(taskId)?.abort()
    this.abortControllers.delete(taskId)

    const slotIndex = this.session.researchSlots.findIndex(s => s?.taskId === taskId)
    if (slotIndex !== -1) {
      this.session.researchSlots[slotIndex] = null
    }

    logger.info("Task cancelled", { taskId })
    return { status: "cancelled" }
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors.

---

## Task 4: Update `gemini-live-session.ts` — tool declaration + system prompt

**Files:**
- Modify: `apps/api/src/gemini-live-session.ts`

- [ ] **Step 1: Update the system prompt constant**

Find `SYSTEM_PROMPT` (line 12). Append the following sentence to the end of the existing string:

```typescript
const SYSTEM_PROMPT = `You are Compass, an AI voice assistant for a financial trading platform.
You help users navigate the platform, place trades, and research stocks.
You never go silent waiting for a tool result — acknowledge tool dispatch and keep talking.
When you receive a message prefixed with [automation context], absorb it silently as background
information. Do not read it aloud or acknowledge it unless the user asks what you are doing
or the task completes.
When dispatching a research task, reconstruct the user's intent into a precise, keyword-dense research question. Include the ticker symbol, the specific time period, and all financial metrics or narrative themes the user mentioned or implied. Do not echo the user's words — synthesize their intent into the best possible search query.`
```

- [ ] **Step 2: Update `dispatch_research` parameter descriptions in `TOOL_DECLARATIONS`**

Replace the existing `dispatch_research` entry:

```typescript
{
  name: "dispatch_research",
  description: "Start a background research task. Returns immediately — result will be injected when ready.",
  parametersJsonSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Short label identifying this research task. Example: \"DANGCEM Q3 2025 earnings\"",
      },
      description: {
        type: "string",
        description: "Precise, keyword-dense research question synthesized from the conversation. Include the ticker symbol, specific time period, and all financial metrics or narrative themes the user mentioned or implied. Example: \"DANGCEM Q3 2025 revenue, EBITDA margin, dividend declared, impact of naira devaluation on input costs\". Do not paraphrase the user — synthesize their intent into the best possible search query.",
      },
    },
    required: ["name", "description"],
  },
},
```

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors.

---

## Task 5: Wire `TaskManager` in `server.ts`

**Files:**
- Modify: `apps/api/src/server.ts`

- [ ] **Step 1: Add the `TaskManager` import**

At the top of `server.ts`, add:

```typescript
import { TaskManager } from "./task-manager.js"
```

- [ ] **Step 2: Update the `open` handler**

Replace the existing `open` handler body. The key change: `createSession` result is captured, `TaskManager` is instantiated and wired before `gemini.connect()`.

```typescript
async open(ws) {
  const sessionId = uuidv4()
  ws.getUserData().sessionId = sessionId

  const send = (msg: ServerMessage) => ws.send(JSON.stringify(msg))
  const session = createSession(sessionId, send)

  const history = await getConversationHistory(sessionId)

  const gemini = new GeminiLiveSession(sessionId, send, history)
  apiSessions.set(sessionId, { sessionId, gemini })

  const taskManager = new TaskManager(session, gemini)
  gemini.onDispatchResearch   = (name, desc) => taskManager.dispatchResearch(name, desc)
  gemini.onDispatchAutomation = (name, desc) => taskManager.dispatchAutomation(name, desc)
  gemini.onCancelTask         = (taskId)     => taskManager.cancel(taskId)

  await gemini.connect()

  ws.send(JSON.stringify({ type: "session_init", sessionId } satisfies ServerMessage))
  logger.info("Client connected", { sessionId, total: sessionCount() })
},
```

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Smoke test — start the dev server**

```bash
pnpm dev
```

Expected: server starts on port 8787 with no import or runtime errors.

---

## Self-Review

**Spec coverage:**
- ✓ Gemini tool param descriptions updated (Task 4)
- ✓ System prompt addition (Task 4)
- ✓ BAML types rewritten (Task 1)
- ✓ `ResearchAgent` calls Responses API with `web_search` (Task 2)
- ✓ `context` (last 3 turns) passed to research agent (Task 3)
- ✓ `dispatchResearch` returns synchronously (Task 3 — `_runResearch` is fire-and-forget)
- ✓ `cancelledTasks` checked before injecting result AND before injecting error (Task 3)
- ✓ Slot cleared on completion, failure, and cancel (Task 3)
- ✓ `dispatchAutomation` stub returns rejected (Task 3)
- ✓ `TaskManager` wired in `server.ts` before `gemini.connect()` (Task 5)

**Placeholder scan:** No TBDs. The `// @ts-expect-error` note in Task 2 is conditional and explained.

**Type consistency:**
- `ResearchOutput`, `BaselineMetrics`, `DynamicContext`, `TemporalValidation` — defined in Task 2, referenced nowhere else (types flow via JSON at runtime, not imported cross-module)
- `Task` — imported from `@compass-ai/types` in Task 3, matches the `session.ts` definition exactly
- `session.researchSlots[slotIndex]` — `[Task | null, Task | null]` — index access with `findIndex` is valid; `slotIndex` is 0 or 1 when used
- `gemini.onDispatchResearch` / `onDispatchAutomation` / `onCancelTask` — signatures match what `GeminiLiveSession` declares (`(name, desc) => Record<string, unknown>` and `(taskId) => Record<string, unknown>`)
