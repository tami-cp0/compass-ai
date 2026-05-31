# Phase 6 Handoff — Research Agent (TaskManager: Research)

## What Was Built

Phase 6 wired the research half of the Back Office. When Gemini calls `dispatch_research`, a `TaskManager` fires a real OpenAI Responses API job (`gpt-4o-search-preview` + `web_search_preview`), returns `{ taskId, status: "dispatched" }` immediately so Gemini keeps talking, then injects the structured JSON result back into the Gemini session when the job completes.

BAML is **not used** for the research agent. BAML targets the Chat Completions API and cannot pass `web_search_preview` as a tool. The research agent calls the OpenAI Responses API directly. BAML is still in place for `WebAgent` (Phase 7).

---

## Architecture

```
Gemini Live (tool call: dispatch_research)
  │  GeminiLiveSession.handleMessage()
  │  → onDispatchResearch(name, description)  ← wired in server.ts open handler
  ▼
TaskManager.dispatchResearch()
  │  finds empty researchSlots[0|1]
  │  creates Task { taskId, type: "research", name, description, status: "running" }
  │  stores AbortController in Map<taskId, AbortController>
  │  fires _runResearch() as fire-and-forget promise
  │  returns { taskId, status: "dispatched" } immediately
  ▼
TaskManager._runResearch()
  │  getConversationHistory(sessionId) → last 3 turns as context string
  │  runResearchAgent(description, context, signal)
  │    → openai.responses.create({ model: "gpt-4o-search-preview", tools: [web_search_preview] })
  │    → parses JSON response → ResearchOutput
  ▼
  On completion:
  │  check session.cancelledTasks.has(taskId) → discard if cancelled
  │  gemini.injectContent(`[research_result: ${name}]\n${JSON.stringify(result)}`)
  │  clear slot → null, delete abortController
  ▼
GeminiLiveSession.injectContent()
  └  session.sendClientContent({ turns: [{ role: "user", parts: [{ text }] }], turnComplete: false })
     → Gemini narrates the result in the live audio session
```

---

## Key Files

### `apps/api/src/research-agent.ts` — New

Calls `openai.responses.create` with `gpt-4o-search-preview` and `web_search_preview`.

**System prompt** encodes:
- Role: backend research microservice, never speaks to end-users
- Temporal anchor: today's date injected at call time
- Execution mandate: parallel web searches for both the immutable baseline (price, P/E, P/B, ROE, ROA, EPS TTM/forward, dividend yield) and the dynamic context (ticker + narrative keywords + temporal filters)
- Output constraint: valid JSON only, no markdown fences
- Evidence instruction: dump verbatim raw text snippets and direct quotes — do not summarize

**Output types** (TypeScript interfaces, not BAML-generated):
```ts
interface ResearchOutput {
  user_original_query: string
  temporal_validation: { data_as_of_date: string; most_recent_quarter_analyzed: string }
  baseline_metrics:    { price?; pe_ratio?; pb_ratio?; roe?; roa?; eps_ttm?; eps_forward?; dividend_yield? }
  dynamic_context:     { identified_themes: string[]; scraped_evidence: string[]; macro_regulatory_updates: string[] }
}
```

**Cancellation:** `AbortSignal` passed as the second argument to `openai.responses.create` — aborts the in-flight HTTP request. Results are also discarded via `cancelledTasks` check regardless.

---

### `apps/api/src/task-manager.ts` — New

`TaskManager` manages research task lifecycle for one WebSocket session.

**Constructor:** `(session: SessionState, gemini: GeminiLiveSession)`
Instantiated once per connection in `server.ts` after `createSession`, before `gemini.connect()`.

**`dispatchResearch(name, description): Record<string, unknown>`**
- Synchronous return — never awaits before returning
- Finds empty slot in `session.researchSlots[0|1]` — returns `{ status: "rejected", reason: "research_slots_full" }` if both occupied
- Creates `Task`, stores `AbortController`, fires `_runResearch()` fire-and-forget
- Returns `{ taskId, status: "dispatched" }`

**`cancel(taskId): Record<string, unknown>`**
- Adds to `session.cancelledTasks`
- Calls `abortControllers.get(taskId)?.abort()`
- Clears the slot holding this taskId
- Returns `{ status: "cancelled" }`

**`dispatchAutomation` stub:** Returns `{ status: "rejected", reason: "automation_not_implemented" }` — Phase 7.

---

### `apps/api/src/gemini-live-session.ts` — Modified

Two changes:

1. **System prompt addition** — new instructions appended:
   - When dispatching research, synthesize user intent into a precise keyword-dense query (ticker, time period, metrics, narrative themes)
   - After dispatching, do not ask follow-up clarifying questions — the job is already running
   - When receiving `[research_result]` prefix, deliver like a colleague who just got a notification — natural transition, most important point first, conversational not robotic

2. **`dispatch_research` parameter descriptions updated** — `description` now explicitly instructs Gemini to include ticker symbol, specific time period, and financial metrics/narrative themes. Example given in the declaration itself.

---

### `apps/api/src/server.ts` — Modified

The `open` handler now wires `TaskManager` before `gemini.connect()`:

```ts
const taskManager = new TaskManager(session, gemini)
gemini.onDispatchResearch   = (name, desc) => taskManager.dispatchResearch(name, desc)
gemini.onDispatchAutomation = (name, desc) => taskManager.dispatchAutomation(name, desc)
gemini.onCancelTask         = (taskId)     => taskManager.cancel(taskId)
await gemini.connect()
```

`session` is the `SessionState` returned by `createSession` — same object `TaskManager` mutates (slots, cancelledTasks).

---

## Key Invariants

- `dispatchResearch` always returns synchronously — no awaits before the return
- Before injecting any result (success or error), always check `session.cancelledTasks.has(taskId)` first — a job that completes milliseconds after cancel is always discarded
- `session.researchSlots` is single source of truth — cleared on completion, error, and cancel
- Slot is cleared and `AbortController` deleted even on error — no leaked state
- `TaskManager` is wired **before** `gemini.connect()` — tool calls can arrive during the connection window

---

## Environment Variables

```
OPENAI_API_KEY=...    # Required — research agent (gpt-4o-search-preview + web_search_preview)
GEMINI_API_KEY=...    # Required — Gemini Live session
REDIS_URL=...         # Required — conversation history
PORT=8787
```

---

## What Phase 7 Must Do

Phase 7 wires the automation half of the `TaskManager` — the `dispatchAutomation` stub currently returns rejected.

### TaskManager.dispatchAutomation responsibilities:
1. Check `session.automationSlot === null` — return `{ status: "rejected", reason: "automation_slot_full" }` if occupied
2. Create a `Task`, set `automationSlot`, fire the BAML `WebAgent` pipeline (GPT-4o)
3. The web agent pipeline communicates with the extension via `dom_snapshot_request`, `action`, `user_action_required` messages — results come back as `dom_snapshot`, `action_result`, `user_action_result` extension messages
4. On step progress, inject silent `[automation context]` parts via `gemini.injectContent`
5. On completion or failure, inject a narrated summary and clear `automationSlot`
6. Honour `cancel(taskId)` — abort the running pipeline, clear slot, discard any late results

### Extension message types already defined (from Phase 5):
```ts
// Extension → API
{ type: "dom_snapshot";       sessionId; taskId; taskType; screenshot; elementMap }
{ type: "action_result";      sessionId; actionId; taskId; success; error? }
{ type: "user_action_result"; sessionId; actionId; taskId; confirmed }

// API → Extension
{ type: "action";              sessionId; actionId; taskId; intent: WebIntent; isCritical }
{ type: "dom_snapshot_request"; sessionId; taskId; taskType }
{ type: "user_action_required"; sessionId; actionId; taskId; description }
{ type: "automation_end";      sessionId; taskId; reason: "complete"|"cancelled"|"error"; error? }
```

These message types are wired in `packages/types/src/messages.ts` but the server-side routing for them (in `server.ts message` handler) is not yet implemented.

---

## Commits (Phase 6)

```
cafe9d8 feat(api): enhance Gemini Live system prompt and configuration
981d578 feat(api): implement research agent with OpenAI web search integration
```
