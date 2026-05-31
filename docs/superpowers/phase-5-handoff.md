# Phase 5 Handoff — Gemini Live Voice Session

## What Was Built

Phase 5 replaced the entire STT → BAML VoiceAgent → OpenAI TTS pipeline with a single Gemini Live bidirectional audio WebSocket session. The extension now streams raw PCM mic audio to the API, Gemini processes it natively (speech-to-speech), and the API streams Gemini's PCM audio output back to the extension for playback.

## What Was Deleted

| File | Why |
|---|---|
| `apps/api/src/voice-agent.ts` | Called BAML VoiceAgent (GPT-4o text pipeline) — replaced by Gemini Live |
| `apps/api/src/tts/tts-provider.ts` | TTS abstraction interface — Gemini handles audio natively |
| `apps/api/src/tts/openai-tts-provider.ts` | OpenAI TTS implementation — gone |
| `apps/extension/src/speech/web-speech-provider.ts` | Web Speech API STT — replaced by PcmCapture |
| `apps/api/baml_src/voice_agent.baml` | BAML VoiceAgent function — dead, Gemini owns conversation |
| `packages/types/src/speech.ts` | SpeechProvider interface — no longer needed |

BAML is **kept** for `ResearchAgent` (Gemini Flash) and `WebAgent` (GPT-4o). Only the voice agent BAML is gone.

---

## Architecture

```
Extension (content script: pill.tsx)
  │  mic audio: PcmCapture → 16kHz PCM → base64
  │  chrome.runtime.sendMessage({ type: "audio_chunk", data, mimeType: "audio/pcm" })
  ▼
Extension (background.ts — service worker)
  │  owns the WebSocket, holds sessionId
  │  injects sessionId into every outbound message
  │  ws.send(JSON.stringify({ type: "audio_chunk", sessionId, data, mimeType }))
  ▼
API (server.ts — uWebSockets.js)
  │  message handler routes audio_chunk → GeminiLiveSession.sendAudio(data)
  ▼
GeminiLiveSession (gemini-live-session.ts)
  │  streams PCM to Gemini Live at 16kHz
  │  receives audio output chunks from Gemini at 24kHz
  │  sends { type: "audio_chunk", sessionId, data, mimeType: "audio/pcm" } back
  ▼
API (server.ts)
  │  ws.send(JSON.stringify(serverMessage))
  ▼
Extension (background.ts)
  │  chrome.tabs.sendMessage(tabId, msg)
  ▼
Extension (pill.tsx)
  └  PcmPlayer.play(msg.data) → 24kHz AudioContext scheduled playback
```

---

## Key Files

### `apps/api/src/gemini-live-session.ts` — The Core

The `GeminiLiveSession` class owns the Gemini Live WebSocket for one user session.

**Constructor:** `(sessionId, send, history: ConversationHistory)`
- `send` — callback to push `ServerMessage` to the extension
- `history` — loaded from Redis on connect, baked into the system prompt

**Methods:**
- `connect()` — opens Gemini Live session with system prompt, tool declarations, audio modality, voice Aoede
- `sendAudio(base64Pcm)` — pipes 16kHz PCM from extension to Gemini
- `injectContent(text)` — sends a silent text part with `turnComplete: false` (used for automation context injection in Phase 6)
- `close()` — tears down the session

**Tool declarations registered with Gemini:**
- `dispatch_research(name, description)` — start a background research task
- `dispatch_automation(name, description)` — start a background automation task
- `cancel_task(taskId)` — cancel a running task

**Tool call handling (Phase 5 stubs):**
Gemini calls tools synchronously during conversation. The session responds immediately so Gemini never waits. In Phase 5, all three handlers are `null` — the stub response is `{ status: "acknowledged", note: "Tool handler not yet wired" }`. Phase 6 wires these via:
```ts
session.onDispatchResearch  = (name, description) => taskManager.dispatchResearch(name, description)
session.onDispatchAutomation = (name, description) => taskManager.dispatchAutomation(name, description)
session.onCancelTask         = (taskId) => taskManager.cancel(taskId)
```

**Transcript → Redis:**
- Input transcription (user speech): written to Redis via `appendTurn` as each chunk arrives
- Output transcription (model speech): buffered incrementally, flushed to Redis on `turnComplete`

**System prompt instructs Gemini:**
- Never go silent waiting for a tool result — acknowledge and keep talking
- Absorb `[automation context]` prefixed messages silently (don't read them aloud)

---

### `apps/api/src/server.ts`

The uWS WebSocket handler. Key changes from Phase 4:

- `open` handler: creates `GeminiLiveSession`, calls `gemini.connect()`, stores in `apiSessions` Map
- `message` handler: routes `audio_chunk` → `gemini.sendAudio(msg.data)`. All other message types log a warning (web agent messages handled in Phase 6)
- `close` handler: calls `gemini.close()`, cleans up maps

`apiSessions` is a separate Map from `sessions` (session-store). `sessions` holds `SessionState` (shared type). `apiSessions` holds `{ sessionId, gemini: GeminiLiveSession }` — the API-only extended handle.

**Race condition fix:** `apiSessions.set(sessionId, ...)` is called **before** `await gemini.connect()` so that audio chunks arriving during the connection window are safely no-ops (not dropped due to missing map entry).

---

### `apps/api/src/redis.ts`

Key changes:
- `Turn.role` changed from `"assistant"` → `"model"` (Gemini convention)
- Rolling window: 6 turns (was 3)
- New function: `appendTurn(sessionId, { role, content })` — replaces `appendConversationTurn`
- New function: `saveConversationHistory(sessionId, history)` — direct write without eviction logic

---

### `packages/types/src/messages.ts`

**ExtensionMessage** (extension → API):
```ts
| { type: "audio_chunk"; sessionId: string; data: string; mimeType: "audio/pcm" }
| { type: "dom_snapshot"; sessionId: string; taskId: string; taskType: DomTaskType; screenshot: string; elementMap: string }
| { type: "action_result"; sessionId: string; actionId: string; taskId: string; success: boolean; error?: string }
| { type: "user_action_result"; sessionId: string; actionId: string; taskId: string; confirmed: boolean }
```

**ServerMessage** (API → extension):
```ts
| { type: "audio_chunk"; sessionId: string; data: string; mimeType: "audio/pcm" }
| { type: "action"; sessionId: string; actionId: string; taskId: string; intent: WebIntent; isCritical: boolean }
| { type: "dom_snapshot_request"; sessionId: string; taskId: string; taskType: DomTaskType }
| { type: "automation_end"; sessionId: string; taskId: string; reason: "complete" | "cancelled" | "error"; error?: string }
| { type: "user_action_required"; sessionId: string; actionId: string; taskId: string; description: string }
| { type: "session_init"; sessionId: string }
```

Old messages that no longer exist: `transcript_input`, `speech_audio`, `automation_start`, `automation_pause`, `automation_resume`, `automation_status`, `research_chunk`.

---

### `packages/types/src/session.ts`

```ts
export interface Task {
  taskId:      string
  type:        "research" | "automation"
  name:        string        // short label shown to user
  description: string        // full question/instruction
  status:      "running" | "completed" | "failed" | "cancelled"
  startedAt:   number
}

export interface SessionState {
  sessionId:      string
  send:           (msg: ServerMessage) => void
  researchSlots:  [Task | null, Task | null]   // max 2 concurrent research tasks
  automationSlot: Task | null                  // max 1 automation task at a time
  cancelledTasks: Set<string>                  // taskIds cancelled — checked before delivering results
}
```

`GeminiLiveSession` is NOT in shared types — it lives only in `apps/api`.

---

### `apps/extension/src/audio/pcm-capture.ts`

Captures mic at 16kHz mono using `ScriptProcessorNode(4096, 1, 1)`. Converts Float32 → Int16 → base64, calls `onChunk(base64)` for each 4096-sample buffer (~256ms of audio at 16kHz).

Note: `ScriptProcessorNode` is deprecated but universally supported in Chrome extensions. AudioWorklet requires registering a worklet file separately which is complex in Plasmo.

Also holds a `MediaRecorder` on the stream (used only to track the stream reference for stopping tracks).

---

### `apps/extension/src/audio/pcm-player.ts`

Plays incoming 24kHz PCM chunks using Web Audio API with a `nextStart` timeline scheduler so chunks play contiguously without gaps or overlaps.

Decodes: base64 → `Uint8Array` → `Int16Array` → `Float32Array` → `AudioBuffer` → scheduled `BufferSourceNode`.

`resume()` must be called on first user gesture (or when AudioContext is suspended) before `play()`.

---

### `apps/extension/src/contents/pill.tsx`

- `player = new PcmPlayer(24000)` — module-scope singleton, preserves `nextStart` across renders
- `captureRef = useRef<PcmCapture | null>` — holds active capture instance
- On mic toggle start: `new PcmCapture(chunk => chrome.runtime.sendMessage({ type: "audio_chunk", data: chunk, mimeType: "audio/pcm" }))` → `capture.start()`
- On mic toggle stop: `captureRef.current.stop()`
- Listens for `ServerMessage` with `type: "audio_chunk"` from background → `player.resume(); player.play(msg.data)`

---

## Environment Variables

```
PORT=8787
REDIS_URL=redis://...
GEMINI_API_KEY=...        # Gemini Live sessions + GeminiFlash research agent
OPENAI_API_KEY=...        # GPT-4o web agent (BAML WebAgent)
```

---

## What Phase 6 Must Do

Phase 6 wires the `TaskManager` — the "Back Office" that actually runs research and automation jobs.

### TaskManager responsibilities:
1. **`dispatchResearch(name, description)`** — find an empty `researchSlots` slot, create a `Task`, start the research BAML call (async), inject result via `gemini.injectContent(result)` when done. Return `{ taskId, status: "dispatched" }` immediately.
2. **`dispatchAutomation(name, description)`** — check `automationSlot` is empty, create a `Task`, run the web agent pipeline, inject completion/failure via `gemini.injectContent(...)`. Return `{ taskId, status: "dispatched" }` immediately.
3. **`cancel(taskId)`** — add to `session.cancelledTasks`, abort the running job via `AbortController`. Check `cancelledTasks` before injecting any result (guaranteed cancel — a result that completes milliseconds after cancel is always discarded).

### Silent context injection pattern:
```ts
// Automation progress (silent — Gemini absorbs without narrating)
gemini.injectContent(`[automation context] Filling order form — found quantity field`)

// Research result (Gemini narrates this)
gemini.injectContent(`Research complete: DANGCEM Q3 2024 revenue was ₦487bn, up 18% YoY.`)

// Automation complete (Gemini narrates this)
gemini.injectContent(`Automation complete: Order form filled with quantity 500 at ₦42.50.`)
```

### Key invariant:
Before injecting any result, always check:
```ts
if (session.cancelledTasks.has(taskId)) return  // discard silently
```

---

## Commits (Phase 5)

```
e96a2ec feat(types): replace STT/TTS schema with audio_chunk + new SessionState for Gemini Live
02362d2 chore(types): remove orphaned dist/speech.* files
df76501 feat(api/redis): rename role assistant→model, expand window to 6, add saveConversationHistory
2e7cb97 feat(api/server): wire audio_chunk routing to GeminiLiveSession, strip STT/TTS pipeline
8fd85c9 feat(api): add @google/genai SDK, GOOGLE_API_KEY env, GeminiFlash BAML client
8d911fb feat(api): add GeminiLiveSession — audio bridge + tool stubs for Gemini Live
9fd8303 fix(api): fix outputTranscription buffering, close() return type, args null guard, apiSessions race
c561b9f feat(extension): replace WebSpeechProvider+MP3 with PCM capture and streaming playback
13c6db5 feat(extension): add microphone permission to manifest
```
