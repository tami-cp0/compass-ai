# Phase 6 Design — Research Agent (TaskManager: Research)

**Date:** 2026-05-31  
**Scope:** Wire the research half of the TaskManager Back Office. Automation is out of scope for this phase.

---

## What This Builds

A `TaskManager` class that handles background research jobs dispatched by Gemini Live tool calls. When Gemini calls `dispatch_research`, the task manager fires a direct OpenAI Responses API call (GPT-4o + `web_search_preview`), returns immediately so Gemini keeps talking, then injects the raw JSON result back into the Gemini session when the research completes.

**Note:** BAML is not used for the research agent. BAML cannot call the OpenAI Responses API (it uses the Chat Completions API), which means it cannot enable `web_search_preview` tooling. The output types (`ResearchOutput`, `BaselineMetrics`, etc.) are defined as TypeScript interfaces directly in `research-agent.ts`.

---

## Section 1: Gemini Tool Declaration — Shaping the Research Input

**File:** `apps/api/src/gemini-live-session.ts`

### Parameter description updates

The `dispatch_research` tool declaration parameter descriptions are updated to instruct Gemini to produce a precise, keyword-rich research request:

- `name`: Short label identifying the research task. Example: `"DANGCEM Q3 2025 earnings"`
- `description`: Full research question with ticker symbol, specific financial metrics or narrative themes, and temporal context drawn from the conversation. Example: `"DANGCEM Q3 2025 revenue, EBITDA margin, dividend declared, impact of naira devaluation on input costs"`. Must be a precise, search-optimised statement — not a paraphrase of what the user said.

### System prompt addition

A short instruction is appended to `SYSTEM_PROMPT`:

> When dispatching a research task, reconstruct the user's intent into a precise, keyword-dense research question. Include the ticker symbol, the specific time period, and all financial metrics or narrative themes the user mentioned or implied. Do not echo the user's words — synthesize their intent into the best possible search query.

---

## Section 2: Research Agent — Direct OpenAI Responses API

**File:** `apps/api/src/research-agent.ts` (new)

BAML is not used here. BAML only targets the Chat Completions API and cannot pass `web_search_preview` as a tool. The research agent calls the OpenAI Responses API directly in TypeScript.

### Output types

Defined as TypeScript interfaces in `research-agent.ts` (no BAML codegen):

```ts
interface TemporalValidation {
  data_as_of_date:              string
  most_recent_quarter_analyzed: string
}

interface BaselineMetrics {
  price?:          number | null
  pe_ratio?:       number | null
  pb_ratio?:       number | null
  roe?:            number | null
  roa?:            number | null
  eps_ttm?:        number | null
  eps_forward?:    number | null
  dividend_yield?: number | null
}

interface DynamicContext {
  identified_themes:        string[]
  scraped_evidence:         string[]
  macro_regulatory_updates: string[]
}

interface ResearchOutput {
  user_original_query: string
  temporal_validation: TemporalValidation
  baseline_metrics:    BaselineMetrics
  dynamic_context:     DynamicContext
}
```

All `BaselineMetrics` fields are nullable — not every query is about a listed equity.

### Function signature

```ts
async function runResearchAgent(description: string, context: string, signal?: AbortSignal): Promise<ResearchOutput>
```

- `description` — keyword-rich research question from Gemini's tool call
- `context` — last 3 conversation turns formatted as `"User: ...\nCompass: ..."`, giving the agent the conversational context behind the query
- `signal` — optional `AbortSignal` for cancellation

### API call

`openai.responses.create` with model `gpt-4o-search-preview` and `tools: [{ type: "web_search_preview" }]`.

### System prompt

The prompt encodes:
- Role: backend research microservice, not a user-facing agent
- Temporal anchor: current date injected at call time (`new Date().toISOString().slice(0, 10)`)
- Execution mandate: parallel `web_search` calls for both the immutable baseline (price, P/E, P/B, ROE, ROA, EPS TTM, EPS forward, dividend/yield — appending "2026 financial metrics" or "latest earnings report") and the dynamic context (targeted searches combining ticker + narrative keywords + temporal filters)
- Output constraint: valid JSON only matching `ResearchOutput`, no conversational text
- Evidence instruction: in `scraped_evidence`, dump verbatim raw text snippets, direct quotes, and precise numerical data — do not summarize

---

## Section 3: TaskManager

**File:** `apps/api/src/task-manager.ts` (new)

### Constructor

```ts
constructor(session: SessionState, gemini: GeminiLiveSession)
```

Instantiated once per WebSocket connection in `server.ts`, after `createSession` and before `gemini.connect()`.

### `dispatchResearch(name, description): Record<string, unknown>`

Synchronous return (called from `GeminiLiveSession.handleMessage` which must not block).

1. Find an empty slot in `session.researchSlots[0]` or `[1]`. If both occupied, return `{ status: "rejected", reason: "research_slots_full" }`.
2. Create a `Task` object (`taskId = uuidv4()`, `type: "research"`, `name`, `description`, `status: "running"`, `startedAt: Date.now()`). Place in empty slot.
3. Create `AbortController`, store in a private `Map<string, AbortController>`.
4. Read the last 3 turns from Redis (`getConversationHistory`) async — fire the BAML call with `description` and the formatted context string. Do not await either — chain as a promise.
5. Return `{ taskId, status: "dispatched" }` immediately.
6. On BAML completion:
   - Check `session.cancelledTasks.has(taskId)` — if true, clear slot and return silently.
   - Call `gemini.injectContent(JSON.stringify(result))`.
   - Set slot back to `null`, update task `status: "completed"`.
7. On error:
   - Check `cancelledTasks` first — if cancelled, discard silently.
   - Call `gemini.injectContent(`[research error] Task "${name}" failed: ${err.message}`)`.
   - Set slot to `null`, update task `status: "failed"`.

### `cancel(taskId): Record<string, unknown>`

1. Add `taskId` to `session.cancelledTasks`.
2. Call `abortControllers.get(taskId)?.abort()`.
3. Find and clear the slot holding this `taskId`.
4. Return `{ status: "cancelled" }`.

### `dispatchAutomation` stub

Returns `{ status: "rejected", reason: "automation_not_implemented" }` for now.

---

## Section 4: server.ts Wiring

**File:** `apps/api/src/server.ts`

In the `open` handler, after `createSession` and before `gemini.connect()`:

```ts
const taskManager = new TaskManager(session, gemini)
gemini.onDispatchResearch   = (name, desc) => taskManager.dispatchResearch(name, desc)
gemini.onDispatchAutomation = (name, desc) => taskManager.dispatchAutomation(name, desc)
gemini.onCancelTask         = (taskId)     => taskManager.cancel(taskId)
```

`session` is the `SessionState` returned by `createSession`.

---

## Files Changed

| File | Change |
|---|---|
| `apps/api/src/gemini-live-session.ts` | Update `dispatch_research` parameter descriptions + system prompt addition |
| `apps/api/src/research-agent.ts` | New file — direct OpenAI Responses API caller with `web_search_preview` |
| `apps/api/src/task-manager.ts` | New file — `TaskManager` class |
| `apps/api/src/server.ts` | Wire `TaskManager` in `open` handler |
| `apps/api/baml_src/research_agent.baml` | Deleted — BAML cannot use Responses API |

---

## Key Invariants

- `dispatchResearch` always returns synchronously — never awaits anything before returning
- Before injecting any result (success or error), always check `session.cancelledTasks.has(taskId)` first
- `session.researchSlots` is the single source of truth for slot state — always clear the slot on completion, failure, or cancel
- The `AbortController` signal is passed as the second argument to `openai.responses.create` — cancellation aborts the in-flight HTTP request; results are also discarded via the `cancelledTasks` check
