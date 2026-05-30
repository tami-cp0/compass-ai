# Compass AI — System Design
**Date:** 2026-05-29 (revised 2026-05-30)
**Scope:** Full system architecture — Gemini Live + Front Desk & Back Office pattern

---

## 1. Overview

Compass AI is a browser extension backed by a Node.js WebSocket server. The user speaks to Compass; Compass understands, acts on the browser, researches the web, and speaks back — all in real time, never blocking the voice interface.

Three agents:

| Agent | Lives | Purpose |
|---|---|---|
| Voice Agent | Backend (Gemini Live) | Persistent audio session. Conversational brain. Dispatches tools without going silent. |
| Web Agent | Backend (BAML + GPT-4o) | DOM automation. Called as a background task by the Voice Agent. |
| Research Agent | Backend (BAML) | Web search + summarization. Called as a background task by the Voice Agent. |

**Core architectural principle — Front Desk & Back Office:**

The Voice Agent (Gemini Live) is the front desk: it never goes silent waiting for work to finish. When it dispatches a tool, Node immediately returns a placeholder acknowledgement so Gemini keeps talking. The actual work (web automation, research) runs as a background job managed by the Node `TaskManager`. When a job completes, its result is injected into the live Gemini session as a new content part. Gemini naturally weaves it into the conversation.

---

## 2. How Messages Flow

```
Extension (Pill)
  │  raw PCM audio chunks (16kHz mono)
  ▼
background.ts ──WebSocket──► Node API Server
                               │
                               ├─ GeminiLiveSession
                               │    • streams audio in/out via Gemini Live API
                               │    • declares tools: dispatch_research,
                               │      dispatch_automation, cancel_task
                               │    • receives injected content parts from TaskManager
                               │
                               └─ TaskManager
                                    • research slots: [task?, task?]  (max 2 concurrent)
                                    • automation slot: task?           (max 1 concurrent)
                                    • AbortController per task
                                    • injects results into GeminiLiveSession on completion
                                    • guaranteed cancel — discards results from cancelled tasks
```

**Gateway role:** The uws WebSocket server routes raw bytes between the extension and the Node backend. It does not understand messages. It does not make decisions.

**GeminiLiveSession role:** One persistent session per connected user. Owns the Gemini Live WebSocket. Streams PCM audio in, receives PCM audio out (played by the extension). Declares the three tool functions. Forwards tool call events to the TaskManager.

**TaskManager role:** Owns all background job state. Tracks running tasks, enforces slot limits, manages cancellation, and injects results back into the GeminiLiveSession.

---

## 3. Infrastructure

| Concern | Solution |
|---|---|
| WebSocket server | µWebSockets.js (uws) — high-throughput, handles extension ↔ Node connection |
| Voice session | Gemini Live API (`gemini-2.0-flash-live`) — persistent bidirectional audio WebSocket |
| Session state | In-memory `Map<sessionId, SessionState>` — lives with the connection |
| Conversation history | Redis — keyed by sessionId, persists across reconnects |
| LLM (web agent) | GPT-4o (vision required for screenshots), called via BAML |
| LLM (research agent) | Gemini 1.5 Flash (fast, cheap for text summarization), called via BAML |
| Agent definitions | BAML — web agent and research agent defined as BAML functions |
| Audio transport | PCM 16kHz mono — extension streams mic audio, receives Gemini audio output |
| Monorepo | pnpm workspaces + Turborepo |

**STT and TTS are fully removed.** Gemini Live handles both natively inside the audio stream. There is no `SpeechProvider`, no `TTSProvider`, no `WebSpeechProvider`, no `OpenAITTSProvider`.

---

## 4. Monorepo Structure

```
compass-ai/
├── apps/
│   ├── extension/        — Plasmo browser extension
│   └── api/              — uws gateway + Gemini Live session + TaskManager + background agents
├── packages/
│   └── types/            — Shared message schema (consumed by both apps)
├── turbo.json
├── package.json
└── pnpm-workspace.yaml
```

---

## 5. Message Schema

All messages are JSON with a `type` discriminant. Defined in `packages/types/src/messages.ts`.

### Extension → Gateway → Node

```ts
// Audio: extension streams raw mic audio as base64-encoded PCM chunks
{ type: "audio_chunk";         sessionId: string; data: string; mimeType: "audio/pcm" }

// Web automation results
{ type: "dom_snapshot";        sessionId: string; taskId: string; taskType: DomTaskType; screenshot: string; elementMap: string }
{ type: "action_result";       sessionId: string; actionId: string; taskId: string; success: boolean; error?: string }
{ type: "automation_status";   sessionId: string; taskId: string; state: "running" | "paused" | "cancelled" }
{ type: "user_action_result";  sessionId: string; actionId: string; taskId: string; confirmed: boolean }
```

### Node → Gateway → Extension

```ts
// Audio: Gemini Live audio output streamed back as PCM chunks
{ type: "audio_chunk";          sessionId: string; data: string; mimeType: "audio/pcm" }

// Web automation instructions
{ type: "action";               sessionId: string; actionId: string; taskId: string; intent: WebIntent; isCritical: boolean }
{ type: "dom_snapshot_request"; sessionId: string; taskId: string; taskType: DomTaskType }
{ type: "automation_start";     sessionId: string; taskId: string; description: string }
{ type: "automation_end";       sessionId: string; taskId: string; reason: "complete" | "cancelled" | "error"; error?: string }
{ type: "user_action_required"; sessionId: string; actionId: string; taskId: string; description: string }

// Session handshake
{ type: "session_init";         sessionId: string }
```

```ts
// WebIntent union
type WebIntent =
  | { action: "click";     element_id: number }
  | { action: "type";      element_id: number; value: string }
  | { action: "scroll";    element_id: number | null; direction: "up" | "down"; amount: number }
  | { action: "highlight"; element_id: number; text_snippet: string }

type DomTaskType = "click" | "form" | "read" | "structure"
```

---

## 6. Task Model

Each background job is a `Task`:

```ts
type TaskType   = "research" | "automation"
type TaskStatus = "running" | "completed" | "failed" | "cancelled"

interface Task {
  taskId:          string            // uuid
  type:            TaskType
  name:            string            // short human label e.g. "DANGCEM Q3 earnings"
  description:     string            // full question or automation instruction
  status:          TaskStatus
  abortController: AbortController
  startedAt:       number
}
```

### Slot Rules (enforced by TaskManager before dispatch)

| Scenario | Behaviour |
|---|---|
| New research, 0–1 slots used | Dispatch immediately |
| New research, 2 slots used | Return conflict payload — names of both running tasks. Gemini delivers: *"You already asked me to research X and Y — wait for those, or scratch both and file this?"* |
| New automation, slot empty | Dispatch immediately |
| New automation, slot occupied | Return conflict payload — name of running task. Gemini delivers: *"You already told me to X — should I stop that and do what you just said?"* |
| Research + automation simultaneously | Allowed — independent slots |

Conflict payloads are structured data returned to Gemini as tool responses. Gemini generates the voice phrasing naturally — no hardcoded strings on the server.

### Cancellation (Guaranteed)

`cancel_task(taskId)`:
1. Sets `task.status = "cancelled"`.
2. Calls `task.abortController.abort()` — interrupts the in-flight BAML call if possible.
3. Adds `taskId` to a `cancelledTasks: Set<string>` on the session.

Before any result is injected into the Gemini session, TaskManager checks `cancelledTasks`. Results from cancelled tasks are silently discarded — even if the job completed milliseconds before the cancel arrived.

---

## 7. GeminiLiveSession

One instance per user session. Wraps the Gemini Live WebSocket.

### Tool Declarations

Three tools are declared in the session config at connection time:

```ts
dispatch_research(name: string, description: string): TaskConflict | { taskId: string }
// name: short label e.g. "DANGCEM Q3 earnings"
// description: full research question
// returns taskId on success, or conflict data if both slots are full

dispatch_automation(name: string, description: string): TaskConflict | { taskId: string }
// name: short label e.g. "Fill order form"
// description: full automation instruction for the web agent
// returns taskId on success, or conflict data if slot is occupied

cancel_task(taskId: string): { cancelled: boolean }
```

### Tool Call Handling

When Gemini calls a tool:
1. Node calls the corresponding TaskManager method.
2. **Immediately** returns the result to Gemini (success + taskId, or conflict data).
3. Gemini never waits — it keeps talking while the background job runs.

### Result Injection

When a background job completes or fails, TaskManager calls `session.injectContent(part)`. This sends a `client_content` message into the Gemini Live WebSocket session. Gemini receives it as new context and naturally incorporates it in the ongoing conversation.

**Research result injection:**
```ts
{
  role: "user",
  parts: [{
    text: `Research task "${task.name}" complete:\n${result}`
  }]
}
```

**Automation complete injection:**
```ts
{
  role: "user",
  parts: [{
    text: `Automation task "${task.name}" completed successfully.`
  }]
}
```

**Automation failed injection:**
```ts
{
  role: "user",
  parts: [{
    text: `Automation task "${task.name}" failed: ${error}`
  }]
}
```

Automation progress events (intermediate steps like "navigated to order book", "click failed, retrying") are injected as `role: "user"` content parts with no trailing model turn request — this updates Gemini's context without triggering a response generation. Gemini only speaks about automation when the final complete/failed injection arrives.

---

## 8. Session State (In-Memory)

```ts
interface SessionState {
  sessionId:    string
  send:         (msg: ServerMessage) => void  // delivers to extension via gateway

  // Task slots
  researchSlots:    [Task | null, Task | null]
  automationSlot:   Task | null
  cancelledTasks:   Set<string>

  // Gemini Live session handle
  geminiSession:    GeminiLiveSession
}
```

---

## 9. Conversation History (Redis)

The Gemini Live session maintains its own rolling context internally. Redis stores a persistent conversation summary that survives reconnects and is injected into the Gemini session system prompt on reconnect.

```ts
// Key: `conversation:{sessionId}`
interface ConversationHistory {
  summary:      string    // rolling compressed summary of all older turns
  recentTurns:  Turn[]    // last 6 turns kept verbatim
}

interface Turn {
  role:      "user" | "model"
  content:   string
  timestamp: number
}
```

### Rolling Summary Strategy

Gemini Live does not have discrete turns in the same sense as a REST call. The Node backend writes to Redis on two triggers: (1) when a tool result is injected — marking the end of a meaningful exchange, and (2) on session close — capturing the final state. If `recentTurns.length > 6`, the oldest turn is compressed into `summary` as one concise fact line. The summary is an ordered list — what the user asked, what was done, what the result was.

Example:
```
1. User asked about DANGCEM stock price. Researched and reported ₦18.50.
2. User asked to place a buy order for 500 units. Web agent filled the form. User confirmed. Order submitted.
3. User asked about portfolio balance. Read the page. Reported ₦2.3M available.
```

On reconnect, the summary + recent turns are injected into the Gemini session system prompt so the conversation resumes with full context.

---

## 10. Web Agent (Extension-Side)

The web agent is content scripts inside the extension — it touches the DOM. It receives instructions from the Node backend (via the gateway) and reports results back.

### DOM Snapshot Strategy

Every `dom_snapshot` contains two parts:

1. **Screenshot** — base64 PNG of the visible viewport.
2. **Compressed element map** — unique `element_id` assigned to every interactable element, with position data kept in extension memory.

```
[Button id=42, text="Confirm Trade", role="button"]
[Input id=17, placeholder="Quantity", type="number"]
[Container id=8, text="GTCO 45.20 +1.2%", scrollable=true]
```

The web agent LLM (GPT-4o via BAML) receives the map and screenshot, outputs structured `WebIntent` actions referencing `element_id` values only — never coordinates.

### Action Execution

**click**
```ts
element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: coords.x, clientY: coords.y }))
element.dispatchEvent(new MouseEvent("mouseup",   { bubbles: true, clientX: coords.x, clientY: coords.y }))
element.dispatchEvent(new MouseEvent("click",     { bubbles: true, clientX: coords.x, clientY: coords.y }))
```

**type**
```ts
element.focus()
element.dispatchEvent(new InputEvent("input", { bubbles: true, data: intent.value }))
;(element as HTMLInputElement).value = intent.value
element.dispatchEvent(new Event("change", { bubbles: true }))
```

**scroll**
```ts
const target = intent.element_id ? elementMap.get(intent.element_id)!.element : window
target.scrollBy({ top: intent.direction === "down" ? intent.amount : -intent.amount, behavior: "smooth" })
```

**highlight**
```ts
const range = document.createRange()
range.setStart(element.firstChild!, index)
range.setEnd(element.firstChild!, index + intent.text_snippet.length)
window.getSelection()!.removeAllRanges()
window.getSelection()!.addRange(range)
```

**Critical action guard:** Any action where `isCritical: true` (buy, sell, withdraw, confirm) is blocked by the extension. It returns `action_result` with `success: false, error: "requires_confirmation"`. The server emits `user_action_required` and waits for `user_action_result` before retrying.

### Automation Progress → Context Injection

As the web automation task runs, the Node backend receives `action_result` messages and builds a time-series log:

```ts
interface AutomationProgressEvent {
  timestamp: number
  description: string   // e.g. "Navigated to order book page"
                        //      "Failed to click confirm button — retrying"
                        //      "Filled quantity field with 500"
}
```

Each progress event is injected into the Gemini session as a silent context part (no speech triggered). When the task ends (complete or failed), a final injection is sent that Gemini can speak about.

---

## 11. BAML — Agent Definitions

Web agent and research agent are BAML functions. BAML generates a type-safe TypeScript client.

```
apps/api/
└── baml_src/
    ├── clients.baml         — model config (GPT-4o for web agent, Gemini 1.5 Flash for research)
    ├── web_agent.baml       — WebAgent: input = task + element map + screenshot → structured WebIntent list
    └── research_agent.baml  — ResearchAgent: input = question → structured summary
```

Swapping models is a one-line change in `clients.baml`. The TaskManager never calls the Gemini Live API — it calls BAML.

---

## 12. Extension — Audio Streaming

The extension streams raw PCM audio from the microphone to the gateway in `audio_chunk` messages. The gateway forwards chunks to the Node backend, which pipes them into the Gemini Live session's input stream.

Gemini Live output audio (PCM) is streamed back the same way: Node → gateway → extension. The extension plays each chunk via the Web Audio API as it arrives — no buffering wait for a complete response.

The mic button in `pill.tsx` starts and stops the audio stream. There is no `SpeechProvider` interface, no transcript messages, no Web Speech API.

---

## 13. Development Phases

### Phase 1 — API Foundation ✓
- uws gateway, TypeScript, tsconfig
- `packages/types`: full message schema
- Redis connection + conversation history store
- Session state in-memory

### Phase 2 — Extension WebSocket Client ✓
- `background.ts` WebSocket client: connects on install, reconnects on drop
- `chrome.runtime.sendMessage` relay between `background.ts` and content scripts

### Phase 3 — Voice Input (STT via Web Speech API) ✓
- `WebSpeechProvider` in extension, mic button in `pill.tsx`
- `transcript_input` flows end-to-end (now superseded by Phase 5)

### Phase 4 — Voice Agent Conversation (BAML + GPT-4o + OpenAI TTS) ✓
- Voice turn loop working end-to-end (now superseded by Phase 5)

### Phase 5 — Gemini Live Voice Session (replaces Phases 3 + 4)
- Remove `WebSpeechProvider`, `SpeechProvider` interface, `TTSProvider` interface, `OpenAITTSProvider`, `handleTranscript`, BAML voice_agent
- `GeminiLiveSession` class: wraps Gemini Live WebSocket, streams PCM audio in/out
- Extension: replace `transcript_input` flow with PCM audio streaming via `audio_chunk`
- `pill.tsx`: replace mic button → Web Speech API flow with mic → PCM capture → `audio_chunk`
- Gemini session config: declare `dispatch_research`, `dispatch_automation`, `cancel_task` tools
- End-to-end voice conversation working through Gemini Live

### Phase 6 — TaskManager + Research Agent
- `TaskManager`: slot enforcement, `AbortController` per task, `cancelledTasks` set, result injection
- `ResearchAgent` BAML function (Gemini 1.5 Flash)
- `dispatch_research` tool wired: fires background job, immediate acknowledgement, result injected on completion
- Conflict handling for research slots
- Guaranteed cancel for research tasks

### Phase 7 — Web Agent: DOM Reading
- `dom-watcher.ts` content script: handles `dom_snapshot_request`, captures DOM + screenshot
- `dom_snapshot` flows: extension → gateway → Node → web agent (BAML + GPT-4o)

### Phase 8 — Web Agent: Action Execution
- `action-executor.ts` content script: receives `action`, executes DOM automation
- `action_result` relay: content script → background → gateway → Node
- Full automation lifecycle: start / end / progress / cancel
- Automation progress events injected as silent context into Gemini session
- `dispatch_automation` tool wired: fires background job, immediate acknowledgement
- Critical action guard + `user_action_required` flow
- Conflict handling for automation slot
- Guaranteed cancel for automation tasks

### Phase 9 — Proactive Context Awareness
- Gemini session receives page context (DOM snapshots) proactively when user navigates
- Gemini can comment on page state without being asked

### Phase 10 — Landing Page
- `apps/web` — built last, after the product works

---

## 14. Out of Scope (Future)

- User accounts + authentication
- Multiple Gemini voice / language options
- Research Agent as a separate process / service
- Deployment / containerization
- Whisper STT (superseded by Gemini Live native STT)
- OpenAI TTS (superseded by Gemini Live native TTS)
