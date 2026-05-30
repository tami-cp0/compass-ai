# Compass AI — System Design
**Date:** 2026-05-29 (revised 2026-05-30)
**Scope:** Full system architecture — Gemini Live + Front Desk & Back Office pattern

---

## 1. Overview

Compass AI is a browser extension backed by a Node.js WebSocket server. The user speaks to Compass; Compass understands, acts on the browser, researches the web, and speaks back — all in real time, never blocking the voice interface.

Three agents:

| Agent | Lives | Purpose |
|---|---|---|
| Voice Agent | Gemini Live (cloud) | Persistent audio session. Conversational brain. Dispatches tools without going silent. |
| Web Agent | Backend (BAML + GPT-4o) | DOM automation planning. Content scripts execute actions in the browser. |
| Research Agent | Backend (BAML + Gemini 1.5 Flash) | Web search + summarization. Runs as a background task. |

**Core architectural principle — Front Desk & Back Office:**

The Voice Agent (Gemini Live) is the front desk: it never goes silent waiting for work to finish. When it dispatches a tool, Node **immediately** returns a placeholder acknowledgement so Gemini keeps talking. The actual work (web automation, research) runs as a background job managed by the Node `TaskManager`. When a job completes, the result is injected into the live Gemini session as a content part. Gemini naturally weaves it into the conversation.

---

## 2. How Messages Flow

```
Extension (Pill)
  │  raw PCM audio (16kHz mono, base64)
  ▼
background.ts ──uws WebSocket──► Node API Server
                                   │
                                   ├─ GeminiLiveSession (1 per user session)
                                   │    • pipes PCM audio in → Gemini Live WebSocket
                                   │    • pipes PCM audio out → extension via uws
                                   │    • declares tools: dispatch_research,
                                   │      dispatch_automation, cancel_task
                                   │    • receives tool_call events → delegates to TaskManager
                                   │    • receives injected content parts from TaskManager
                                   │    • emits turn transcripts for Redis history
                                   │
                                   └─ TaskManager (1 per user session)
                                        • research slots: [task?, task?]  (max 2 concurrent)
                                        • automation slot: task?           (max 1 concurrent)
                                        • AbortController per task
                                        • injects results into GeminiLiveSession on completion
                                        • guaranteed cancel — discards results from cancelled tasks
```

**Gateway (uws):** Routes raw bytes between the extension and the Node backend. Does not understand messages. Does not make decisions.

**GeminiLiveSession:** One instance per connected user. Owns two WebSocket connections — one to the extension (via uws), one to Gemini Live. Acts as the audio bridge between them. Also handles the Gemini tool call / tool response cycle and delegates background work to TaskManager.

**TaskManager:** Owns all background job state. Enforces slot limits, runs BAML calls as async jobs, manages cancellation, and injects results back into the GeminiLiveSession when jobs complete.

---

## 3. Infrastructure

| Concern | Solution |
|---|---|
| Extension ↔ Node transport | µWebSockets.js (uws) — handles the extension WebSocket connection |
| Voice session | Gemini Live API (`gemini-2.0-flash-live`) — persistent bidirectional audio + tool calling |
| Session state | In-memory `Map<sessionId, SessionState>` — lives with the connection |
| Conversation history | Redis — keyed by sessionId, persists across reconnects |
| Web agent planner | GPT-4o via BAML (vision required for DOM screenshots) |
| Research agent | Gemini 1.5 Flash via BAML (fast, cheap for text summarization) |
| Agent definitions | BAML — web agent and research agent defined as BAML functions |
| Audio format | PCM 16kHz mono — extension captures mic, sends to Node, Node pipes to Gemini Live |
| Monorepo | pnpm workspaces + Turborepo |

**What is fully removed vs. the previous architecture:**
- `SpeechProvider` interface and `WebSpeechProvider` — Gemini Live handles STT natively
- `TTSProvider` interface and `OpenAITTSProvider` — Gemini Live handles TTS natively
- `handleTranscript()` — the per-turn orchestrator function is gone; Gemini Live owns the conversation loop
- BAML `voice_agent.baml` — replaced by Gemini Live session with declared tools
- `transcript_input` message type — replaced by `audio_chunk` streaming

---

## 4. Monorepo Structure

```
compass-ai/
├── apps/
│   ├── extension/        — Plasmo browser extension
│   └── api/              — uws gateway + GeminiLiveSession + TaskManager + BAML agents
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
// Mic audio: raw PCM streamed in real time
{ type: "audio_chunk";        sessionId: string; data: string; mimeType: "audio/pcm" }

// Web automation: extension reports results back to Node
{ type: "dom_snapshot";       sessionId: string; taskId: string; taskType: DomTaskType; screenshot: string; elementMap: string }
{ type: "action_result";      sessionId: string; actionId: string; taskId: string; success: boolean; error?: string }
{ type: "user_action_result"; sessionId: string; actionId: string; taskId: string; confirmed: boolean }
```

### Node → Gateway → Extension

```ts
// Gemini audio output: PCM streamed back in real time
{ type: "audio_chunk";          sessionId: string; data: string; mimeType: "audio/pcm" }

// Web automation instructions sent to the extension
{ type: "dom_snapshot_request"; sessionId: string; taskId: string; taskType: DomTaskType }
{ type: "action";               sessionId: string; actionId: string; taskId: string; intent: WebIntent; isCritical: boolean }
{ type: "automation_end";       sessionId: string; taskId: string; reason: "complete" | "cancelled" | "error"; error?: string }
{ type: "user_action_required"; sessionId: string; actionId: string; taskId: string; description: string }

// Session handshake
{ type: "session_init";         sessionId: string }
```

```ts
type WebIntent =
  | { action: "click";     element_id: number }
  | { action: "type";      element_id: number; value: string }
  | { action: "scroll";    element_id: number | null; direction: "up" | "down"; amount: number }
  | { action: "highlight"; element_id: number; text_snippet: string }

type DomTaskType = "click" | "form" | "read" | "structure"
```

Note: there are no `transcript_input`, `speech_audio`, `automation_status`, `automation_start`, `automation_pause`, `automation_resume`, or `research_chunk` messages in this architecture. Those belonged to the old STT/LLM/TTS turn-based loop and are removed.

---

## 6. Task Model

Each background job managed by TaskManager is a `Task`:

```ts
type TaskType   = "research" | "automation"
type TaskStatus = "running" | "completed" | "failed" | "cancelled"

interface Task {
  taskId:          string
  type:            TaskType
  name:            string            // short human label e.g. "DANGCEM Q3 earnings"
  description:     string            // full question or automation instruction
  status:          TaskStatus
  abortController: AbortController
  startedAt:       number
}
```

### Slot Rules (enforced before dispatch)

| Scenario | Behaviour |
|---|---|
| New research, 0–1 slots used | Dispatch immediately, return `{ taskId }` to Gemini |
| New research, 2 slots used | Return `{ conflict: true, type: "research", running: [name1, name2] }` — Gemini delivers the conflict in voice |
| New automation, slot empty | Dispatch immediately, return `{ taskId }` to Gemini |
| New automation, slot occupied | Return `{ conflict: true, type: "automation", running: name }` — Gemini delivers the conflict in voice |
| Research + automation simultaneously | Allowed — fully independent slots |

Conflict payloads are structured data. Gemini generates the voice phrasing — no hardcoded strings on the server. The user's reply (cancel the old one / keep it) is handled by Gemini calling `cancel_task` or doing nothing.

### Cancellation (Guaranteed)

`cancel_task(taskId)`:
1. Sets `task.status = "cancelled"`.
2. Calls `task.abortController.abort()` — interrupts the BAML call mid-flight if possible.
3. Adds `taskId` to `session.cancelledTasks: Set<string>`.

Before any result injection, TaskManager checks `cancelledTasks`. Results from cancelled tasks are silently discarded — even if the job completed milliseconds before the cancel arrived.

---

## 7. GeminiLiveSession

One instance per user session. Owns the Gemini Live WebSocket connection and acts as the audio + tool bridge.

### Audio Bridge

```
Extension mic audio
  → uws receives audio_chunk
  → GeminiLiveSession.sendAudio(pcmChunk)
  → Gemini Live input stream

Gemini Live output stream
  → GeminiLiveSession receives audio delta
  → session.send({ type: "audio_chunk", data: pcmChunk })
  → uws delivers to extension
  → pill.tsx plays via Web Audio API
```

Audio flows continuously in both directions. There is no request/response cycle.

### Tool Declarations

Registered in the Gemini session config at connection time:

```ts
dispatch_research(name: string, description: string): { taskId: string } | { conflict: true, type: "research", running: string[] }
dispatch_automation(name: string, description: string): { taskId: string } | { conflict: true, type: "automation", running: string }
cancel_task(taskId: string): { cancelled: boolean }
```

### Tool Call Cycle

```
Gemini emits tool_call event
  → GeminiLiveSession receives it
  → calls TaskManager.dispatch*(name, description) or TaskManager.cancel(taskId)
  → TaskManager returns result synchronously (slot check only, no async work yet)
  → GeminiLiveSession sends tool_response back to Gemini immediately
  → Gemini keeps talking
  → TaskManager runs the actual job in the background
```

### Result and Progress Injection

TaskManager calls `session.injectContent(part)` to push context into the live session.

**Injection format:**
```ts
// Research complete
{ role: "user", parts: [{ text: `Research "${task.name}" complete:\n${result}` }] }

// Research failed
{ role: "user", parts: [{ text: `Research "${task.name}" failed: ${error}` }] }

// Automation complete
{ role: "user", parts: [{ text: `Automation "${task.name}" completed successfully.` }] }

// Automation failed
{ role: "user", parts: [{ text: `Automation "${task.name}" failed: ${error}` }] }

// Automation progress (silent context — does NOT trigger Gemini to speak)
{ role: "user", parts: [{ text: `[automation context] ${description}` }] }
// These are prefixed with [automation context] so the system prompt instructs Gemini
// to absorb them silently and only reference them if asked or when the task ends.
```

### Transcript Events for Redis

Gemini Live emits `turn_complete` events with the full text of what Gemini said. Node captures these and writes them to Redis as `{ role: "model", content: text }` turns. User speech transcripts come from Gemini Live's `input_transcription` events and are written as `{ role: "user", content: text }` turns.

---

## 8. Session State (In-Memory)

```ts
interface SessionState {
  sessionId:      string
  send:           (msg: ServerMessage) => void   // delivers to extension via uws

  // Task slots
  researchSlots:  [Task | null, Task | null]
  automationSlot: Task | null
  cancelledTasks: Set<string>

  // Gemini Live session
  geminiSession:  GeminiLiveSession
}
```

`session.send(msg)` is the only way to put a message on the wire to the extension. The uws socket handle lives in the gateway; the rest of the system never touches it directly.

---

## 9. Conversation History (Redis)

Gemini Live maintains its own in-session context. Redis stores a persistent summary that survives disconnects and is injected into the system prompt on reconnect.

```ts
// Key: `conversation:{sessionId}`
interface ConversationHistory {
  summary:     string   // rolling compressed summary of all older turns
  recentTurns: Turn[]   // last 6 turns kept verbatim
}

interface Turn {
  role:      "user" | "model"
  content:   string
  timestamp: number
}
```

### When Redis is Written

Node writes to Redis on two triggers:
1. **Tool result injected** — a meaningful exchange just completed (research delivered, automation finished). Captures the turns that led to and followed the task.
2. **Session close** — captures whatever the final conversation state was.

There are no discrete HTTP-style turns to write back. Node listens to Gemini Live's `turn_complete` and `input_transcription` events to build the turn log.

### Rolling Summary

If `recentTurns.length > 6`, the oldest turn is shifted out and appended to `summary` as one concise fact line. The summary is an ordered list — what the user asked, what happened, what the result was.

```
1. User asked about DANGCEM stock price. Researched and reported ₦18.50.
2. User asked to place a buy order for 500 units. Web agent filled the form. User confirmed. Order submitted.
3. User asked about portfolio balance. Read the page. Reported ₦2.3M available.
```

On reconnect, the summary + recent turns are prepended to the Gemini session system prompt.

---

## 10. Web Agent — Backend Planner (BAML + GPT-4o)

When TaskManager dispatches an automation task, it runs the web agent planning loop on the backend:

```
TaskManager dispatches automation job
  → sends dom_snapshot_request to extension via session.send
  → extension content script captures DOM + screenshot
  → extension sends dom_snapshot back to Node
  → TaskManager passes { task, elementMap, screenshot } to WebAgent BAML function (GPT-4o)
  → WebAgent returns ordered list of WebIntent actions
  → TaskManager sends each action to extension via session.send({ type: "action", ... })
  → extension executes and returns action_result
  → for each result:
      success → log progress event, inject silent context into Gemini
      failure → retry or mark task failed, inject failure into Gemini
      critical action → send user_action_required, wait for user_action_result
  → task complete → inject completion into Gemini, update TaskManager slot
```

The web agent LLM never sees Gemini Live. It only receives a DOM snapshot and outputs intents. It does not know about the voice session.

---

## 11. Web Agent — Extension Content Scripts

The extension-side web agent executes the intents produced by the backend planner. It is purely mechanical — receive intent, execute browser API call, report result.

### DOM Snapshot

When the extension receives `dom_snapshot_request`, it:
1. Queries all interactable elements: `button`, `input`, `select`, `textarea`, `a[href]`, `[role=button]`, `[role=link]`, `[role=menuitem]`, `[role=option]`, and scrollable containers.
2. Assigns each a unique integer `element_id` (reset per snapshot).
3. Calls `getBoundingClientRect()` on each, stores `element_id → { element, coords }` in content script memory.
4. Builds compressed text representation:
```
[Button id=42, text="Confirm Trade", role="button"]
[Input id=17, placeholder="Quantity", type="number"]
[Container id=8, text="GTCO 45.20 +1.2%", scrollable=true]
```
5. Captures screenshot via `chrome.tabs.captureVisibleTab()`.
6. Sends `dom_snapshot` to background.ts → gateway.

### Intent Execution

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

**Critical action guard:** If `isCritical: true` (buy, sell, withdraw, confirm), the content script does NOT execute. It immediately returns `action_result` with `success: false, error: "requires_confirmation"`. The Node backend emits `user_action_required` to the extension. The extension shows a confirmation UI. The user's response comes back as `user_action_result`. Node retries the action if confirmed, or marks it cancelled if denied.

---

## 12. BAML — Agent Definitions

Only the backend agents (web + research) use BAML. The voice agent is Gemini Live — not BAML.

```
apps/api/
└── baml_src/
    ├── clients.baml         — model config: GPT4o client (web agent), GeminiFlash client (research)
    ├── web_agent.baml       — WebAgent(task, elementMap, screenshot) → WebIntent[]
    └── research_agent.baml  — ResearchAgent(question) → structured summary string
```

The voice_agent.baml from the previous architecture is deleted.

---

## 13. Extension — Audio Streaming (pill.tsx)

The mic button in `pill.tsx` starts and stops a `MediaRecorder` or `AudioWorklet` capturing raw PCM at 16kHz mono. Each audio chunk is base64-encoded and sent as an `audio_chunk` message to background.ts, which forwards it over the WebSocket to Node.

Gemini Live audio output arrives at Node as PCM deltas. Node base64-encodes each delta and sends it to the extension as `audio_chunk`. `pill.tsx` decodes and plays each chunk via the Web Audio API as it arrives — no buffering, no waiting for a complete utterance.

There is no `SpeechProvider`, no Web Speech API, no transcript messages, no `playAudio(base64Mp3)` function. All of that is replaced by the PCM audio stream.

---

## 14. Development Phases

### Phase 1 — API Foundation ✓
- uws gateway, TypeScript, tsconfig
- `packages/types`: full message schema
- Redis connection + conversation history store
- Session state in-memory

### Phase 2 — Extension WebSocket Client ✓
- `background.ts` WebSocket client: connects on install, reconnects on drop
- `chrome.runtime.sendMessage` relay between `background.ts` and content scripts

### Phase 3 — Voice Input via Web Speech API ✓ (superseded)
### Phase 4 — Voice Agent via BAML + GPT-4o + OpenAI TTS ✓ (superseded)

### Phase 5 — Gemini Live Voice Session
**Removes:** `WebSpeechProvider`, `SpeechProvider`, `TTSProvider`, `OpenAITTSProvider`, `handleTranscript`, `voice_agent.baml`, `transcript_input` and `speech_audio` message types.
**Adds:**
- `GeminiLiveSession` class: opens Gemini Live WebSocket, declares tools, pipes audio in/out
- Extension `pill.tsx`: replace Web Speech API with PCM `AudioWorklet` capture → `audio_chunk` messages
- Extension `pill.tsx`: replace `playAudio(base64Mp3)` with streaming PCM playback via Web Audio API
- `session_init` handshake unchanged — session lifecycle stays the same
- Gemini system prompt: includes persona, silent-context instruction for `[automation context]` prefixed parts
- End-to-end voice conversation working through Gemini Live with no other agents wired yet

### Phase 6 — TaskManager + Research Agent
- `TaskManager` class: slot enforcement, `AbortController` per task, `cancelledTasks` set, `injectContent()` method
- `ResearchAgent` BAML function (Gemini 1.5 Flash)
- `dispatch_research` tool wired end-to-end: Gemini calls it → immediate ack → background BAML job → inject result
- Conflict handling: two concurrent research tasks triggers conflict payload
- Guaranteed cancel for research tasks

### Phase 7 — Web Agent: DOM Reading
- `dom-watcher.ts` content script: handles `dom_snapshot_request`, captures element map + screenshot
- `dom_snapshot` flows: extension → gateway → Node → `WebAgent` BAML call (GPT-4o)
- `dispatch_automation` tool partially wired: read-only tasks only (no action execution yet)

### Phase 8 — Web Agent: Action Execution
- `action-executor.ts` content script: receives `action` messages, executes DOM intents, returns `action_result`
- Full automation planning loop: snapshot → BAML → intents → execute → progress inject → complete inject
- Critical action guard + `user_action_required` / `user_action_result` flow
- Conflict handling for automation slot
- Guaranteed cancel for automation tasks
- Automation progress injected as silent `[automation context]` parts into Gemini session

### Phase 9 — Proactive Context Awareness
- Extension sends DOM snapshots proactively on navigation events
- Gemini session receives page context and can comment on it without being asked

### Phase 10 — Landing Page
- `apps/web` — built last, after the product works

---

## 15. Out of Scope (Future)

- User accounts + authentication
- Multiple Gemini voice / language options
- Research Agent as a separate process / service
- Deployment / containerization
- Whisper STT (Gemini Live handles STT natively)
- OpenAI TTS (Gemini Live handles TTS natively)
