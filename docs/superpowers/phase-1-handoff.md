# Phase 1 Handoff — API Foundation

**Date:** 2026-05-29  
**Spec:** `docs/superpowers/specs/2026-05-29-api-foundation-design.md`  
**Stack:** pnpm workspaces + Turborepo, ESM (NodeNext), µWebSockets.js, ioredis, BAML

---

## What Was Built

### `packages/types` — Shared Type Contract

**`src/messages.ts`** — Full discriminated union for every message the extension and API can exchange.

```
ExtensionMessage (extension → API):
  transcript_input   — STT partial/final transcripts
  audio_chunk        — raw audio when using Whisper STT
  dom_snapshot       — { screenshot: string, elementMap: string, taskType }
  action_result      — { actionId, taskId, success, error? }
  automation_status  — running | paused | cancelled
  user_action_result — { actionId, taskId, confirmed } for critical actions

ServerMessage (API → extension):
  transcript         — echo back STT text
  speech_audio       — TTS audio chunk
  action             — { intent: WebIntent, isCritical } — single action to execute
  dom_snapshot_request
  automation_start / pause / resume / cancel / end / progress
  research_chunk     — streaming research text (for UI display only, not voice agent)
  user_action_required — blocks extension, waits for user confirm before executing

WebIntent (discriminated union, field on "action" message):
  { action: "click"; element_id: number }
  { action: "type";  element_id: number; value: string }
  { action: "scroll"; element_id: number | null; direction: "up"|"down"; amount: number }
  { action: "highlight"; element_id: number; text_snippet: string }
```

**Why `WebIntent` is a discriminated union on `action` (not `ServerMessage`):** The extension receives one `action` message per web agent action. `isCritical` is a top-level flag so the extension can gate execution without parsing intent details. `WebIntent` carries only what the extension needs to execute — no selector, no coordinates.

**Why element_id (not selectors or coordinates):**  
The extension scans the DOM, assigns sequential integer IDs to all interactable elements, records `getBoundingClientRect()` center for each, and sends the element map to the web agent. The LLM (GPT-4o) outputs only the `element_id`. The extension resolves the ID back to coordinates and executes via native browser events (`MouseEvent`, `InputEvent`, `Range/Selection`). This avoids:
- Selector brittleness (dynamic class names, shadow DOM)
- Coordinate hallucination (LLM has never seen the page)
- Accessibility tree size explosion (pruned element map is compact)

**`src/session.ts`** — In-memory session shape used by the gateway.

```ts
SessionState {
  sessionId, send,
  automationState: "idle" | "running" | "paused" | "cancelled",
  currentTaskId, currentAutomationDescription,
  isResearching, researchDescription,
  activeTasks: Map<taskId, { type, description }>,
  taskQueue: QueuedTask[]   // each has queuedReason (LLM-generated string)
}
```

---

### `apps/api` — WebSocket Gateway

**`src/logger.ts`** — Structured JSON logger (`info`, `warn`, `error`). All log calls use `{ sessionId, ... }` context objects.

**`src/redis.ts`** — ioredis client (ESM: `import { Redis } from "ioredis"`).

```
ConversationHistory { summary: string, recentTurns: Turn[] }
MAX_RECENT_TURNS = 6

getConversationHistory(sessionId)          → ConversationHistory
appendConversationTurn(sessionId, turn, newSummary?)  → void
```

Rolling summary design: `recentTurns` holds the last 6 turns verbatim. When compression fires (triggered by caller, not automatic), caller passes `newSummary` and the slice drops to the last 6. Summary is a concise ordered list of facts, never dialogue. This keeps LLM context bounded without losing long-term awareness.

**`src/session-store.ts`** — In-memory `Map<string, SessionState>`. Comment: `// temporarily in memory`. Upgrade path: move to Redis when horizontal scaling is needed.

**`src/server.ts`** — µWebSockets.js gateway.

```
App().ws("/ws", {
  compression: DISABLED,
  maxPayloadLength: 16 MB,
  idleTimeout: 120s,
  open   → uuid sessionId, createSession
  message → parse JSON ExtensionMessage, log type (routing is Phase 2)
  close  → deleteSession
})
```

Why uws (not socket.io / ws): uws handles thousands of concurrent connections at native throughput. The voice agent makes multiple downstream LLM calls per user turn — backpressure matters at scale.

**`src/index.ts`** — Entry point. Connects Redis (`lazyConnect`), then calls `startServer()`. If Redis fails, server still starts (Redis errors are logged, not fatal at startup).

---

### `apps/api/baml_src` — BAML Agent Scaffolds

BAML generates type-safe TypeScript clients into `baml_client/` (gitignored, rebuilt on `pnpm build`).

**`clients.baml`**

```baml
client Claude  → anthropic / claude-sonnet-4-6   (voice agent, research agent)
client GPT4o   → openai / gpt-4o                 (web agent — vision required)
```

**`voice_agent.baml`** — `VoiceAgent(input: VoiceAgentInput) -> VoiceAgentOutput`

Input fields the voice agent sees every turn:
```
summary              — rolling fact summary of older turns
recentTurns          — last 3 turns verbatim
userMessage          — current user utterance
automationDescription? — what the web agent is currently doing (null if idle)
researchDescription?   — what is being researched (null if idle)
screenshot?            — base64 PNG of current page
researchResult?        — completed research result (injected once, then cleared)
actionError?           — web agent failure description
```

Output:
```
response            — what to say to the user (always present)
tool?               — "browser_action" | "research" | "request_dom_snapshot" | null
browserActionTask?  — plain-language task for the web agent (required if tool=browser_action)
researchQuestion?   — exact question (required if tool=research)
```

Key design decisions:
- Voice agent speaks in first person: "I am currently doing X", not "the tool is doing X"
- If automation/research is in progress and user asks "what are you doing?", answer from state fields — no tool call
- Voice agent does NOT confirm critical actions — it hands off via `browser_action`, extension blocks with `user_action_required`, user confirms in extension UI
- Voice agent does NOT receive research stream — only the completed `researchResult` when done
- Screenshot goes to voice agent (visual awareness), element map does NOT (no targeting needed)

**`web_agent.baml`** — `WebAgent(task: string, elementMap: string, screenshot: string) -> WebAgentOutput`

```
WebAction {
  action: "click" | "type" | "scroll" | "highlight"
  element_id?: int       — from element map, never guessed
  value?: string         — text for "type"
  direction?: "up"|"down" — for "scroll"
  amount?: int           — pixels for "scroll"
  text_snippet?: string  — exact substring for "highlight"
  isCritical: bool       — true for buy/sell/withdraw/deposit/confirm
  description: string    — one-sentence human-readable description
}

WebAgentOutput { actions: WebAction[] }
```

Rules in prompt: use element map as source of truth, never guess IDs, isCritical for financial actions. Web agent receives both screenshot (spatial context) and element map (targeting).

**`research_agent.baml`** — `ResearchAgent(question: string) -> ResearchOutput`

```
ResearchOutput { summary: string, sources: string[] }
```

Prompt: concise, factual, recent data, credible sources only. Uses Claude (not GPT-4o) — no vision needed for research.

---

### Config / Tooling

**`.env.example`**
```
PORT=8787
REDIS_URL=redis://:<password>@<host>:<port>   ← Redis Cloud format
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
```

**`turbo.json`** — build/dev/typecheck pipeline across workspaces.

**`.gitignore`** — covers `dist/`, `baml_client/`, `.env`.

No Docker anywhere. Redis Cloud via env var. Deployment target: Vercel.

---

## What Is NOT Done (Phase 2+)

| Item | Notes |
|------|-------|
| Message routing | `server.ts` logs message type but does nothing with it. Full handler dispatch is Phase 2 |
| Voice agent invocation | `VoiceAgent()` is defined in BAML but never called from server code |
| Web agent invocation | Same — BAML scaffold only |
| Research agent invocation | Same |
| STT pipeline | Web Speech API adapter not built. `audio_chunk` messages received but ignored |
| TTS pipeline | OpenAI TTS not wired. `speech_audio` messages never sent |
| Conversation summary compression | `appendConversationTurn` accepts `newSummary` param but compression logic (when to call VoiceAgent to compress) is not written |
| Task queue execution | `taskQueue` field exists in `SessionState`, queue logic not implemented |
| `dom_snapshot_request` flow | Server never sends this; extension never receives it |
| Redis Cloud credentials | `.env.example` has placeholder. Real URL needed in `.env` |
| `packages/types` rebuild | If `messages.ts` was edited after last build, run `pnpm --filter @compass-ai/types build` before Phase 2 work |

---

## Key Architectural Invariants (Do Not Break)

1. **Element IDs are ephemeral.** The extension assigns fresh IDs on every DOM scan. Never cache an element_id across turns.

2. **`isCritical` is the gate.** Any action with `isCritical: true` must pause and send `user_action_required` to the extension before executing. The voice agent never blocks on this — it already handed off.

3. **Research stream is UI-only.** `research_chunk` goes to the extension for display. The voice agent only sees `researchResult` (the completed summary) injected into its next turn context.

4. **Rolling summary, not full history.** Never pass the full conversation to the LLM. `summary` + last 6 `recentTurns` is the contract. Compression fires when `recentTurns.length` exceeds the threshold (implementation decision for Phase 2).

5. **Voice agent speaks for itself.** `browserActionTask` is a plain-language instruction — the web agent interprets it. Never pass raw user utterance to the web agent.

6. **One action message per action.** The server sends one `action` message per `WebAction` in the array, in order, waiting for `action_result` before sending the next.
