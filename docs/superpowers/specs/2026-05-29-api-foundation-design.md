# Compass AI — System Design
**Date:** 2026-05-29
**Scope:** Full system architecture + Phase 1 API Foundation

---

## 1. Overview

Compass AI is a browser extension backed by a Node.js WebSocket server. The user speaks to Compass; Compass understands, acts on the browser, researches the web, and speaks back — all in real time, all streaming, never blocking.

Three agents:

| Agent | Lives | Purpose |
|---|---|---|
| Voice Agent | Backend | STT → LLM orchestrator → TTS. The brain. Decides everything. |
| Web Agent | Extension | DOM capture + action execution on the live page. Pluggable. |
| Research Agent | Backend | Web search + real-time summarization. Pluggable. Added last. |

---

## 2. How Messages Actually Flow

Understanding who sends what is critical. There are two backend components with distinct roles:

**Gateway** — the uws WebSocket server. Its only job is to accept connections, maintain sessions in memory, and route raw bytes between the extension and the voice agent. It does not make decisions. It does not understand messages.

**Voice Agent** — the LLM orchestrator. It is the only component that decides what to send to the extension. When the voice agent wants to click something, it tells the gateway to deliver an `action` message to the extension. When the extension sends a `dom_snapshot`, the gateway delivers it to the voice agent.

```
Extension ──[WebSocket]──► Gateway ──► Voice Agent
Extension ◄─[WebSocket]─── Gateway ◄── Voice Agent
```

So "backend → extension" always means "voice agent decided → gateway delivered." These two phrases mean the same thing throughout this document.

The web agent lives entirely inside the extension. It is not a server — it is the DOM-touching code running in the browser. The voice agent instructs it via the gateway.

---

## 3. Infrastructure

| Concern | Solution |
|---|---|
| WebSocket server | µWebSockets.js (uws) — chosen for high-throughput multi-user load |
| Session state | In-memory `Map<sessionId, SessionState>` — lives with the connection |
| Conversation history | Redis — keyed by sessionId, persists across reconnects |
| LLM (voice + research agents) | Claude, called via BAML |
| LLM (web agent) | GPT-4o (vision required for screenshots), called via BAML |
| Agent definitions | BAML — all three agents defined as BAML functions, client is a one-line swap per agent |
| TTS | OpenAI TTS now, swappable behind `TTSProvider` interface |
| STT | Web Speech API now → Whisper later, behind `SpeechProvider` interface |
| Monorepo | pnpm workspaces + Turborepo |

---

## 4. Monorepo Structure

```
compass-ai/
├── apps/
│   ├── extension/        — Plasmo browser extension
│   └── api/              — uws gateway + voice agent + research agent
├── packages/
│   └── types/            — Shared message schema (consumed by both apps)
├── turbo.json
├── package.json
└── pnpm-workspace.yaml
```

---

## 5. Message Schema

All messages are JSON with a `type` discriminant. Defined in `packages/types/src/messages.ts`.

### Extension → Gateway → Voice Agent

```ts
// Phase 3 (Web Speech API): extension sends transcribed text
{ type: "transcript_input";    sessionId: string; text: string; isFinal: boolean }
// Future (Whisper): extension streams raw audio instead
{ type: "audio_chunk";         sessionId: string; data: string; mimeType: string }
{ type: "dom_snapshot";        sessionId: string; taskType: DomTaskType; screenshot: string; elementMap: string }
// screenshot: base64 PNG of visible viewport
// elementMap: flattened text map of interactable elements with element_ids
{ type: "action_result";       sessionId: string; actionId: string; taskId: string; success: boolean; error?: string }
{ type: "automation_status";   sessionId: string; taskId: string; state: "running"|"paused"|"cancelled" }
```

### Voice Agent → Gateway → Extension

```ts
{ type: "transcript";           sessionId: string; text: string; isFinal: boolean }
{ type: "speech_audio";         sessionId: string; data: string; mimeType: "audio/mp3"; isFinal: boolean }
{ type: "action";               sessionId: string; actionId: string; taskId: string; intent: WebIntent; isCritical: boolean }
// WebIntent is one of:
// { action: "click",     element_id: number }
// { action: "type",      element_id: number; value: string }
// { action: "scroll",    element_id: number | null; direction: "up"|"down"; amount: number }
// { action: "highlight", element_id: number; text_snippet: string }
{ type: "dom_snapshot_request"; sessionId: string; taskId: string; taskType: DomTaskType }
{ type: "automation_start";     sessionId: string; taskId: string; description: string }
{ type: "automation_pause";     sessionId: string; taskId: string }
{ type: "automation_resume";    sessionId: string; taskId: string }
{ type: "automation_cancel";    sessionId: string; taskId: string }
{ type: "automation_end";       sessionId: string; taskId: string; reason: "complete"|"cancelled"|"error"; error?: string }
{ type: "automation_progress";     sessionId: string; taskId: string; description: string }
{ type: "research_chunk";          sessionId: string; taskId: string; text: string; isFinal: boolean }
{ type: "user_action_required";    sessionId: string; actionId: string; taskId: string; description: string }
// e.g. description: "Confirm purchase of 500 units of DANGCEM at ₦18.50"
```

### Extension → Gateway → Voice Agent (additions)

```ts
{ type: "user_action_result";   sessionId: string; actionId: string; taskId: string; confirmed: boolean }
// Extension sends this after user taps confirm or cancel on the user_action_required prompt
```

where `DomTaskType = "click" | "form" | "read" | "structure"`

---

## 6. Session State (In-Memory, Gateway)

The gateway owns session state. The voice agent reads and mutates it via the session store API.

```ts
interface SessionState {
  sessionId: string
  send: (msg: ServerMessage) => void   // delivers a message to the extension via the gateway

  // Automation state
  automationState: "idle" | "running" | "paused" | "cancelled"
  currentTaskId: string | null
  currentAutomationDescription: string | null  // what the web agent is currently doing, e.g. "Looking for the order book to show you the bid/ask spread"

  // Research state
  isResearching: boolean
  researchDescription: string | null  // what is being researched, e.g. "DANGCEM Q3 earnings". null when not researching.

  // Task queue
  activeTasks: Map<string, { type: "automation" | "research"; description: string }>
  taskQueue: Array<{
    taskId: string
    type: "automation" | "research"
    description: string
    queuedReason: string   // e.g. "User asked to check DANGCEM while MTNN research was running"
    queuedAt: number
  }>
}
```

`session.send(msg)` is the only way the voice agent puts a message on the wire to the extension. The gateway owns the WebSocket handle; the voice agent never touches it directly.

The voice agent answers "what are you doing?" by reading `currentAutomationDescription` and `researchDescription` directly from session state — it does not need an LLM call to answer this.

---

## 7. Conversation History (Redis)

```ts
// Key: `conversation:{sessionId}`
interface ConversationHistory {
  summary: string          // rolling compressed summary of all older turns
  recentTurns: Turn[]      // last N turns kept verbatim (N = 6)
}

interface Turn {
  role: "user" | "assistant"
  content: string
  timestamp: number
}
```

### Rolling Summary Strategy

The LLM context never grows unboundedly. After each turn, if `recentTurns.length > 3`, the oldest turn is compressed into `summary` and dropped from `recentTurns`.

The summary is a **ordered list of concise facts** — what the user asked, what was done, what the result was. No filler. No explanations.

Example:
```
1. User asked about DANGCEM stock price. Voice agent researched and reported ₦18.50.
2. User asked to place a buy order for 500 units. Web agent filled the form. User confirmed. Order submitted successfully.
3. User asked about portfolio balance. Voice agent read the page. Reported ₦2.3M available.
```

Each new summary is generated by the LLM itself — the voice agent sends the oldest turn to Claude with the instruction: *"Add this to the existing summary as one concise fact. Keep the list ordered. Be brief."*

### What the LLM Receives Per Turn

Only these go into the LLM context:

| Input | Always? | Notes |
|---|---|---|
| `summary` | Yes | Compressed history — bounded size |
| `recentTurns` (last 3) | Yes | Verbatim recent turns |
| `transcript_input` | Yes | Current user utterance |
| `automationState` | Yes | Current automation description or null — so LLM knows if web agent is busy |
| `researchState` | Yes | Current research description or null — so LLM knows if research is in progress |
| `screenshot` | Only when page context needed | Base64 PNG — for visual description and page awareness |
| `research result` | Only when research completes | Full result as a single tool_result |
| `action_result` on failure | Only on failure | Voice agent handles success silently in code |

Action successes, automation progress events, and research chunks are **never injected into the LLM context**. They are operational state managed by the voice agent in code. The voice agent generates narration for the user independently — it does not need the LLM to narrate every step.

Loaded from Redis at the start of each turn. Written back to Redis after each turn.

---

## 8. Voice Agent Loop

The voice agent is the brain. It is the only component that reads incoming extension messages and decides what to do. It streams always — it talks *through* tool execution, never *after* it.

```
Extension sends transcript_input
  → Gateway routes to Voice Agent
  → Voice Agent loads { summary, recentTurns } from Redis
  → Voice Agent builds LLM input: [summary, recentTurns, current transcript]
  → Voice Agent starts LLM call (Claude API, prompt caching)

  LLM may call tools:

  tool: request_dom_snapshot
    → Voice Agent calls session.send({ type: "dom_snapshot_request", taskType })
    → Gateway delivers to Extension
    → Extension captures screenshot + element map, sends dom_snapshot back
    → Gateway routes dom_snapshot to Voice Agent
    → Voice Agent feeds screenshot into next LLM call as visual context
    → LLM continues

  tool: browser_action  [LLM provides: browserActionTask — e.g. "Find the order form and fill quantity with 500"]
    → Voice Agent sets session.currentAutomationDescription from browserActionTask
    → Voice Agent calls WebAgent(task: browserActionTask, elementMap, screenshot) via BAML
    → Web agent returns ordered list of WebActions
    → Voice Agent sets session.currentAutomationDescription and calls session.send({ type: "automation_start", ... })
    → Voice Agent sends each action as session.send({ type: "action", intent, isCritical })
    → For each action:
        - success → Voice Agent updates automation state in code silently
        - failure → Voice Agent feeds action_result error as tool_result into next LLM call
        - critical action (buy/sell/withdraw) → Voice Agent calls session.send({ type: "user_action_required", actionId, taskId, description })
          → UI presents action to user. Voice agent pauses and waits for user_action_result.
    → Voice Agent calls session.send({ type: "automation_end", ... }) when done
    → Voice Agent sets session.currentAutomationDescription = null

  tool: research  [LLM provides: researchQuestion — e.g. "What are DANGCEM Q3 2024 earnings?"] [ONLY if Research Agent is enabled — see Section 13]
    → Voice Agent sets session.isResearching = true, session.researchDescription = researchQuestion
    → Research Agent runs — streams chunks to extension as research_chunk (UI feedback only, NOT fed to voice agent or LLM)
    → Research complete → Voice Agent receives full result as a single return value
    → Voice Agent sets session.isResearching = false, session.researchDescription = null
    → Voice Agent feeds full result as tool_result into LLM
    → LLM generates response using the complete result

  → BAML function returns LLM response
  → TTSProvider.synthesize(text) → audio buffer
  → Voice Agent calls session.send({ type: "speech_audio", ... })
  → Extension plays audio via Web Audio API
  → Voice Agent compresses history and writes { summary, recentTurns } back to Redis
```

### Task Conflict Handling

Before starting any new task, the voice agent checks `session.activeTasks`. If a task is running:
- Voice agent surfaces the conflict via speech: *"I'm already checking MTNN — you just asked me to check DANGCEM. Should I finish MTNN first or switch now?"*
- If switching: cancel active task, start new one
- If queuing: push to `session.taskQueue` with a LLM-generated `queuedReason`
- When active task ends: dequeue next task, tell user: *"Now starting what you asked earlier — [description]"*

---

## 9. Web Agent (Extension-Side, Pluggable)

The web agent is code inside the extension — content scripts that touch the DOM. It is not a server. It receives instructions from the voice agent (via the gateway) and reports results back.

### Pluggability

The web agent is optional. If the web agent content scripts are not loaded or report unavailable, the voice agent degrades gracefully:

- Voice agent detects no `action_result` within timeout, or extension sends an explicit `{ type: "automation_status", state: "cancelled", error: "web_agent_unavailable" }`
- Voice agent tells the user: *"I'm unable to perform browser actions right now."*
- All other functionality (conversation, research) continues normally.

### DOM Snapshot Strategy

The extension sends a **two-part payload** in every `dom_snapshot`:

1. **Screenshot** — base64 PNG of the visible viewport. Gives the LLM visual/spatial awareness so it can describe the page naturally ("GTCO is right between Zenith and First Bank on the equity page"). Always included.

2. **Compressed element map** — the extension scans the live DOM, assigns a unique `element_id` to every interactable element (`button`, `input`, `select`, `a`, `[role=button]`, scrollable containers, relevant text blocks), and computes `getBoundingClientRect()` center coordinates for each. The LLM receives a flattened text map. The extension keeps the ID→coords mapping in memory.

Example element map entry:
```
[Button id=42, text="Confirm Trade", role="button"]
[Input id=17, placeholder="Quantity", type="number"]
[Container id=8, text="GTCO 45.20 +1.2%", scrollable=true]
```

The LLM never sees or generates coordinates. It outputs an `element_id` and the extension handles all execution.

### Action Execution

The LLM outputs a strict intent schema. The extension translates intents into native browser API calls:

**Click / Hover**
```json
{ "action": "click", "element_id": 42 }
```
Extension: looks up ID 42, uses `getBoundingClientRect()` center, dispatches native `MouseEvent`.

**Type**
```json
{ "action": "type", "element_id": 17, "value": "500" }
```
Extension: focuses the input, dispatches native `InputEvent`.

**Scroll**
```json
{ "action": "scroll", "element_id": 15, "direction": "down", "amount": 500 }
```
`element_id` is optional — if null, scrolls the main window. Extension uses `element.scrollBy({ top: 500, behavior: "smooth" })`.

**Highlight**
```json
{ "action": "highlight", "element_id": 8, "text_snippet": "Babcock University" }
```
Extension: locates element ID 8, searches for the text string, uses browser `Range` and `Selection` APIs to highlight it. Used to draw the user's attention to something on the page.

**Safety rule:** Any action where `isCritical: true` (buy, sell, withdraw, confirm) is blocked by the extension. It returns `action_result` with `success: false, error: "requires_confirmation"`. The voice agent then emits `user_action_required` and waits for the user to confirm before retrying.

### action_result Flow (detailed)

```
Voice Agent → session.send({ type: "action", actionId, taskId, intent, isCritical })
  → Gateway delivers to Extension
  → Content script looks up element_id in its ID→coords map
  → Content script dispatches native browser API call
  → Content script → background.ts (chrome.runtime.sendMessage)
  → background.ts → Gateway (WebSocket send)
  → Gateway routes to Voice Agent
  → Voice Agent receives { type: "action_result", actionId, taskId, success }
  → Voice Agent continues
```

---

## 10. Web Automation Technique — How the Extension Executes Actions

This section explains the exact mechanism the extension uses to automate the browser. A developer implementing the web agent content script must follow this precisely.

### Step 1 — DOM Scan and Element Map Construction

When the extension receives a `dom_snapshot_request`, a content script runs on the active tab and does the following:

1. Queries all interactable elements: `button`, `input`, `select`, `textarea`, `a[href]`, `[role=button]`, `[role=link]`, `[role=menuitem]`, `[role=option]`, and any element with a scroll overflow.
2. Assigns each element a unique integer `element_id` (incrementing from 1, reset per snapshot).
3. Calls `element.getBoundingClientRect()` on each element to get its position and size. Computes the center point: `{ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }`.
4. Stores the mapping `element_id → { element: DOMElement, coords: {x, y} }` in content script memory.
5. Builds a compressed text representation of the map:
```
[Button id=1, text="Login", role="button"]
[Input id=2, placeholder="Email", type="email"]
[Input id=3, placeholder="Password", type="password"]
[Container id=4, text="Order Book", scrollable=true]
```
6. Captures a screenshot using the Chrome `chrome.tabs.captureVisibleTab()` API (base64 PNG).
7. Sends both as a `dom_snapshot` message to the gateway.

### Step 2 — LLM Decides Intent

The backend passes the element map and screenshot to the Web Agent (GPT-4o). The LLM reads the map, understands the page visually from the screenshot, and outputs a list of `WebAction` intents referencing only `element_id` values it received. It never generates coordinates.

### Step 3 — Extension Executes Intents

The extension receives `action` messages one by one from the gateway. For each:

**click**
```ts
const { element, coords } = elementMap.get(intent.element_id)
element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: coords.x, clientY: coords.y }))
element.dispatchEvent(new MouseEvent("mouseup",   { bubbles: true, clientX: coords.x, clientY: coords.y }))
element.dispatchEvent(new MouseEvent("click",     { bubbles: true, clientX: coords.x, clientY: coords.y }))
```

**type**
```ts
const { element } = elementMap.get(intent.element_id)
element.focus()
element.dispatchEvent(new InputEvent("input", { bubbles: true, data: intent.value }))
;(element as HTMLInputElement).value = intent.value
element.dispatchEvent(new Event("change", { bubbles: true }))
```

**scroll**
```ts
const target = intent.element_id ? elementMap.get(intent.element_id).element : window
const amount = intent.direction === "down" ? intent.amount : -intent.amount
target.scrollBy({ top: amount, behavior: "smooth" })
```

**highlight**
```ts
const { element } = elementMap.get(intent.element_id)
const text = element.textContent ?? ""
const index = text.indexOf(intent.text_snippet)
if (index === -1) { /* report failure */ return }
const range = document.createRange()
range.setStart(element.firstChild!, index)
range.setEnd(element.firstChild!, index + intent.text_snippet.length)
const selection = window.getSelection()!
selection.removeAllRanges()
selection.addRange(range)
```

**Critical action guard**
```ts
if (intent.isCritical) {
  // Do NOT execute. Report back immediately.
  sendToBackground({ type: "action_result", actionId, taskId, success: false, error: "requires_confirmation" })
  return
}
```

### Step 4 — Report Result

After execution (success or failure), the content script sends `action_result` to `background.ts` via `chrome.runtime.sendMessage`. `background.ts` forwards it over the WebSocket to the gateway.

---

## 11. BAML — Agent Definitions

All three agents are defined as BAML functions in `apps/api/baml_src/`. BAML generates a type-safe TypeScript client that the voice agent, web agent, and research agent call instead of raw Claude API calls.

Benefits:
- Structured outputs enforced by schema — no manual JSON parsing
- Prompt and model config live in `.baml` files, not scattered in TypeScript
- Swapping models (e.g. Claude Sonnet → Opus) is a one-line change in the BAML config
- Prompt caching configured once in BAML, applied automatically

```
apps/api/
└── baml_src/
    ├── clients.baml        — model + caching config (Claude API key, model, cache settings)
    ├── voice_agent.baml    — VoiceAgent function: input = transcript + history, output = response + tool calls
    ├── web_agent.baml      — WebAgent function: input = task + pruned accessibility tree + content snapshot, output = structured actions
    └── research_agent.baml — ResearchAgent function: input = question, output = structured summary
```

The generated BAML client lives at `apps/api/baml_client/` (gitignored, generated at build time).

---

## 12. TTSProvider Interface (Swappable)

```ts
interface TTSProvider {
  synthesize(text: string): Promise<Buffer>  // returns audio/mp3 buffer
}
```

- **OpenAITTSProvider** — Phase 4 implementation, uses OpenAI `tts-1` model
- Future providers (ElevenLabs, etc.) drop in with the same interface

The voice agent calls `ttsProvider.synthesize(text)` and sends the result as `speech_audio` chunks. Swapping providers requires changing only which implementation is instantiated.

---

## 13. SpeechProvider Interface (Swappable)

```ts
interface SpeechProvider {
  start(): void
  stop(): void
  onTranscript: (text: string, isFinal: boolean) => void
}
```

- **WebSpeechProvider** — Phase 3, uses browser Web Speech API, sends `transcript_input` messages
- **WhisperProvider** — future drop-in, streams `audio_chunk` messages to backend Whisper endpoint, same interface

Swapping providers requires changing only which implementation is instantiated — the voice agent loop does not change.

---

## 14. Research Agent (Backend-Side, Pluggable, Phase 7)

```ts
interface ResearchAgent {
  query(question: string, taskId: string, onChunk: (text: string, isFinal: boolean) => void): Promise<void>
  cancel(taskId: string): void
}
```

### Pluggability

The research agent is fully optional. The voice agent checks `researchAgent.isAvailable()` before calling `query`. If unavailable:

- Voice agent tells the user: *"I'm unable to research right now."*
- Conversation and browser automation continue normally.

The voice agent is built and tested without the research agent. The research agent is wired in Phase 5 without modifying the voice agent loop — only the tool registration changes.

### Streaming

 The voice agent can cancel mid-stream via `researchAgent.cancel(taskId)`.

---

## 15. Development Phases

### Phase 1 — API Foundation
- `apps/api`: uws gateway, TypeScript, tsconfig
- `packages/types`: full message schema
- Gateway: accepts connections, manages `SessionState` in-memory, routes messages, logs
- Redis: local Docker, connection wired, conversation history store ready
- Root `turbo.json` pipeline

### Phase 2 — Extension WebSocket Client
- `background.ts` WebSocket client: connects on install, reconnects on drop
- Chrome `runtime.sendMessage` relay between `background.ts` and content scripts
- End-to-end handshake verified

### Phase 3 — Voice Input
- `SpeechProvider` interface in `packages/types`
- `WebSpeechProvider` implementation in extension
- Mic button in `pill.tsx` activates recognition
- `transcript_input` flows: extension → gateway → voice agent (logged)

### Phase 4 — Voice Agent (Conversation)
- Voice agent loop: `transcript_input` → LLM → TTS → `speech_audio` → extension plays
- Claude API with prompt caching
- Redis conversation history: load on turn start, append on turn end
- Multi-turn context working end-to-end

### Phase 5 — Web Agent: DOM Reading
- `src/contents/dom-watcher.ts`: handles `dom_snapshot_request`, captures task-aware DOM
- Sends `dom_snapshot` back to gateway → voice agent

### Phase 6 — Web Agent: Action Execution
- `src/contents/action-executor.ts`: receives `action`, executes hybrid parallel strategy
- `action_result` relay: content script → background → gateway → voice agent
- Full automation lifecycle: start / pause / resume / cancel / end / progress
- Web agent pluggability + degraded mode enforced

### Phase 7 — Research Agent
- `ResearchAgent` interface + first implementation
- Voice agent registers research as a tool (no other voice agent changes)
- Streaming chunks, real-time narration, cancel mid-stream
- Research agent pluggability + degraded mode enforced

### Phase 8 — Proactive Conversation
- Voice agent evaluates incoming DOM snapshots proactively
- Triggers unprompted speech when it detects interesting context

### Phase 9 — Landing Page
- `apps/web` — built last, after the product works

---

## 16. Out of Scope (Future)

- User accounts + authentication
- TTS provider selection / voice customization
- Whisper STT implementation
- Research Agent as a separate process
- Deployment / containerization
