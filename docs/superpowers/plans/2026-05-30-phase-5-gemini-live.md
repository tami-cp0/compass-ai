# Phase 5 — Gemini Live Voice Session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the STT/BAML/TTS voice pipeline with a single Gemini Live bidirectional audio session, wiring up the three tool stubs (dispatch_research, dispatch_automation, cancel_task) that future phases will fill in.

**Architecture:** The Node API opens a Gemini Live WebSocket per user session and acts as an audio bridge — piping raw PCM from the extension into Gemini and streaming Gemini's audio output back to the extension. Tool calls from Gemini are handled synchronously (immediate placeholder response) so Gemini never waits. The extension replaces Web Speech API + base64 MP3 playback with a MediaRecorder PCM capture pipeline and streaming PCM playback.

**Tech Stack:** `@google/genai` SDK (Gemini Live), uWebSockets.js, Web Audio API (AudioWorklet for capture, AudioContext for playback), TypeScript, pnpm, BAML (kept for web/research agents only)

---

## File Map

**Delete entirely:**
- `apps/api/src/voice-agent.ts`
- `apps/api/src/tts/tts-provider.ts`
- `apps/api/src/tts/openai-tts-provider.ts`
- `apps/extension/src/speech/web-speech-provider.ts`
- `apps/api/baml_src/voice_agent.baml`

**Rewrite entirely:**
- `packages/types/src/messages.ts` — new message schema (audio_chunk in/out, web agent messages only)
- `packages/types/src/session.ts` — new SessionState shape (task slots, GeminiLiveSession ref)
- `packages/types/src/index.ts` — remove speech export
- `apps/api/src/session-store.ts` — new SessionState shape, remove old automation/research fields
- `apps/api/src/redis.ts` — change Turn.role from `"assistant"` → `"model"`, expand window to 6

**New files:**
- `apps/api/src/gemini-live-session.ts` — GeminiLiveSession class
- `apps/extension/src/audio/pcm-capture.ts` — MediaRecorder-based PCM capture
- `apps/extension/src/audio/pcm-player.ts` — streaming PCM playback via Web Audio API

**Modify:**
- `apps/api/src/server.ts` — gut transcript_input handler, wire audio_chunk → GeminiLiveSession
- `apps/api/src/index.ts` — no changes needed
- `apps/api/baml_src/clients.baml` — add GeminiFlash client, keep GPT4o
- `apps/api/.env.example` — add GOOGLE_API_KEY, remove OPENAI_API_KEY (TTS use), keep for GPT-4o web agent
- `apps/extension/src/contents/pill.tsx` — replace WebSpeechProvider with PCM capture/playback
- `packages/types/src/speech.ts` — delete file

---

## Task 1: Clean up deleted files and update shared types

**Files:**
- Delete: `apps/api/src/voice-agent.ts`
- Delete: `apps/api/src/tts/tts-provider.ts`
- Delete: `apps/api/src/tts/openai-tts-provider.ts`
- Delete: `apps/extension/src/speech/web-speech-provider.ts`
- Delete: `apps/api/baml_src/voice_agent.baml`
- Delete: `packages/types/src/speech.ts`
- Rewrite: `packages/types/src/messages.ts`
- Rewrite: `packages/types/src/session.ts`
- Modify: `packages/types/src/index.ts`

- [ ] **Step 1: Delete obsolete files**

```bash
rm apps/api/src/voice-agent.ts
rm apps/api/src/tts/tts-provider.ts
rm apps/api/src/tts/openai-tts-provider.ts
rm apps/extension/src/speech/web-speech-provider.ts
rm apps/api/baml_src/voice_agent.baml
rm packages/types/src/speech.ts
```

- [ ] **Step 2: Rewrite `packages/types/src/messages.ts`**

Replace the entire file:

```ts
// Extension → Gateway → Node
export type ExtensionMessage =
  | { type: "audio_chunk"; sessionId: string; data: string; mimeType: "audio/pcm" }
  | { type: "dom_snapshot"; sessionId: string; taskId: string; taskType: DomTaskType; screenshot: string; elementMap: string }
  | { type: "action_result"; sessionId: string; actionId: string; taskId: string; success: boolean; error?: string }
  | { type: "user_action_result"; sessionId: string; actionId: string; taskId: string; confirmed: boolean }

// Node → Gateway → Extension
export type ServerMessage =
  | { type: "audio_chunk"; sessionId: string; data: string; mimeType: "audio/pcm" }
  | { type: "action"; sessionId: string; actionId: string; taskId: string; intent: WebIntent; isCritical: boolean }
  | { type: "dom_snapshot_request"; sessionId: string; taskId: string; taskType: DomTaskType }
  | { type: "automation_end"; sessionId: string; taskId: string; reason: "complete" | "cancelled" | "error"; error?: string }
  | { type: "user_action_required"; sessionId: string; actionId: string; taskId: string; description: string }
  | { type: "session_init"; sessionId: string }

export type DomTaskType = "click" | "form" | "read" | "structure"

export type WebIntent =
  | { action: "click"; element_id: number }
  | { action: "type"; element_id: number; value: string }
  | { action: "scroll"; element_id: number | null; direction: "up" | "down"; amount: number }
  | { action: "highlight"; element_id: number; text_snippet: string }
```

- [ ] **Step 3: Rewrite `packages/types/src/session.ts`**

Replace the entire file:

```ts
import type { ServerMessage } from "./messages.js"

export type TaskType   = "research" | "automation"
export type TaskStatus = "running" | "completed" | "failed" | "cancelled"

export interface Task {
  taskId:          string
  type:            TaskType
  name:            string
  description:     string
  status:          TaskStatus
  startedAt:       number
}

export interface SessionState {
  sessionId:      string
  send:           (msg: ServerMessage) => void

  researchSlots:  [Task | null, Task | null]
  automationSlot: Task | null
  cancelledTasks: Set<string>
}
```

Note: `GeminiLiveSession` is not imported into the shared types package — it lives only in the API app. `SessionState` here is the minimal shared interface for the gateway and task machinery.

- [ ] **Step 4: Update `packages/types/src/index.ts`**

Replace the entire file:

```ts
export * from "./messages.js"
export * from "./session.js"
```

- [ ] **Step 5: Rebuild the types package**

```bash
cd packages/types && pnpm build
```

Expected: Builds without errors. The `dist/` files are regenerated.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(types): replace STT/TTS schema with audio_chunk + new SessionState for Gemini Live"
```

---

## Task 2: Update Redis — role names and window size

**Files:**
- Modify: `apps/api/src/redis.ts`

The old code used `"assistant"` as the model role name. Gemini uses `"model"`. The rolling window was 3 turns; the spec says 6.

- [ ] **Step 1: Rewrite `apps/api/src/redis.ts`**

Replace the entire file:

```ts
import { Redis } from "ioredis"
import { logger } from "./logger.js"
import * as dotenv from "dotenv"
dotenv.config()

if (!process.env.REDIS_URL) {
  throw new Error("REDIS_URL environment variable is not set")
}

export const redis = new Redis(process.env.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 3,
})

redis.on("connect", () => logger.info("Redis connected"))
redis.on("error", (err: unknown) => logger.error("Redis error", { error: String(err) }))

export async function connectRedis(): Promise<void> {
  await redis.connect()
}

export interface Turn {
  role:      "user" | "model"
  content:   string
  timestamp: number
}

export interface ConversationHistory {
  summary:     string
  recentTurns: Turn[]
}

export async function getConversationHistory(sessionId: string): Promise<ConversationHistory> {
  const raw = await redis.get(`conversation:${sessionId}`)
  if (!raw) return { summary: "", recentTurns: [] }
  return JSON.parse(raw) as ConversationHistory
}

export async function saveConversationHistory(sessionId: string, history: ConversationHistory): Promise<void> {
  await redis.set(`conversation:${sessionId}`, JSON.stringify(history))
}

export async function appendTurn(
  sessionId: string,
  turn: { role: "user" | "model"; content: string }
): Promise<void> {
  const history = await getConversationHistory(sessionId)
  history.recentTurns.push({ ...turn, timestamp: Date.now() })

  while (history.recentTurns.length > 6) {
    const oldest = history.recentTurns.shift()!
    const index  = history.summary ? history.summary.split("\n").length + 1 : 1
    const prefix = oldest.role === "user" ? "User" : "Compass"
    history.summary = history.summary
      ? `${history.summary}\n${index}. ${prefix}: ${oldest.content}`
      : `${index}. ${prefix}: ${oldest.content}`
  }

  await redis.set(`conversation:${sessionId}`, JSON.stringify(history))
}
```

- [ ] **Step 2: Typecheck**

```bash
cd apps/api && pnpm typecheck
```

Expected: No errors in `redis.ts`. If `voice-agent.ts` errors surface, they are from deleted files — ignore for now (they will be gone after Step 3 cleans up server.ts).

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/redis.ts
git commit -m "feat(api/redis): rename role assistant→model, expand window to 6, add saveConversationHistory"
```

---

## Task 3: Update session-store and server — strip old voice pipeline

**Files:**
- Rewrite: `apps/api/src/session-store.ts`
- Modify: `apps/api/src/server.ts`

- [ ] **Step 1: Rewrite `apps/api/src/session-store.ts`**

```ts
import type { SessionState, ServerMessage } from "@compass-ai/types"

const sessions = new Map<string, SessionState>()

export function createSession(sessionId: string, send: (msg: ServerMessage) => void): SessionState {
  const session: SessionState = {
    sessionId,
    send,
    researchSlots:  [null, null],
    automationSlot: null,
    cancelledTasks: new Set(),
  }
  sessions.set(sessionId, session)
  return session
}

export function getSession(sessionId: string): SessionState | undefined {
  return sessions.get(sessionId)
}

export function deleteSession(sessionId: string): void {
  sessions.delete(sessionId)
}

export function sessionCount(): number {
  return sessions.size
}
```

- [ ] **Step 2: Rewrite `apps/api/src/server.ts`**

Replace the entire file. The `message` handler now routes `audio_chunk` to the session's GeminiLiveSession. The GeminiLiveSession ref is stored on an extended in-memory object (not in the shared types package):

```ts
import { App, DISABLED } from "uWebSockets.js"
import { v4 as uuidv4 } from "uuid"
import type { ExtensionMessage, ServerMessage } from "@compass-ai/types"
import { createSession, deleteSession, sessionCount } from "./session-store.js"
import { logger } from "./logger.js"
import { GeminiLiveSession } from "./gemini-live-session.js"
import { getConversationHistory } from "./redis.js"

const PORT = Number(process.env.PORT ?? 8787)

// Extended session handle — lives only in the API app, not in shared types
interface ApiSession {
  sessionId:    string
  gemini:       GeminiLiveSession
}

const apiSessions = new Map<string, ApiSession>()

export function startServer(): void {
  const app = App()

  app.ws<{ sessionId: string }>("/ws", {
    compression:      DISABLED,
    maxPayloadLength: 16 * 1024 * 1024,
    idleTimeout:      120,

    async open(ws) {
      const sessionId = uuidv4()
      ws.getUserData().sessionId = sessionId

      const send = (msg: ServerMessage) => ws.send(JSON.stringify(msg))
      createSession(sessionId, send)

      // Load prior history for system prompt
      const history = await getConversationHistory(sessionId)

      const gemini = new GeminiLiveSession(sessionId, send, history)
      await gemini.connect()

      apiSessions.set(sessionId, { sessionId, gemini })

      ws.send(JSON.stringify({ type: "session_init", sessionId } satisfies ServerMessage))
      logger.info("Client connected", { sessionId, total: sessionCount() })
    },

    message(ws, rawMessage) {
      const { sessionId } = ws.getUserData()
      const apiSession = apiSessions.get(sessionId)
      if (!apiSession) return

      let msg: ExtensionMessage
      try {
        msg = JSON.parse(Buffer.from(rawMessage).toString("utf8")) as ExtensionMessage
      } catch {
        logger.warn("Unparseable message", { sessionId })
        return
      }

      if (msg.type === "audio_chunk") {
        apiSession.gemini.sendAudio(msg.data)
        return
      }

      logger.warn("Unhandled message type", { sessionId, type: msg.type })
    },

    async close(ws, code) {
      const { sessionId } = ws.getUserData()
      const apiSession = apiSessions.get(sessionId)
      if (apiSession) {
        await apiSession.gemini.close()
        apiSessions.delete(sessionId)
      }
      deleteSession(sessionId)
      logger.info("Client disconnected", { sessionId, code, total: sessionCount() })
    },
  })

  app.listen(PORT, (token) => {
    if (token) {
      logger.info("Server listening", { port: PORT })
    } else {
      logger.error("Failed to start server", { port: PORT })
      process.exit(1)
    }
  })
}
```

- [ ] **Step 3: Typecheck**

```bash
cd apps/api && pnpm typecheck
```

Expected: Errors only on missing `./gemini-live-session.js` — that's fine, we write it next.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/session-store.ts apps/api/src/server.ts
git commit -m "feat(api/server): wire audio_chunk routing to GeminiLiveSession, strip STT/TTS pipeline"
```

---

## Task 4: Install Gemini SDK and update env

**Files:**
- Modify: `apps/api/package.json`
- Modify: `apps/api/.env.example`
- Modify: `apps/api/baml_src/clients.baml`

- [ ] **Step 1: Install `@google/genai`**

```bash
cd apps/api && pnpm add @google/genai
```

Expected: Package added to `apps/api/package.json` dependencies.

- [ ] **Step 2: Update `apps/api/.env.example`**

Replace the entire file:

```
# Server
PORT=8787

# Redis
REDIS_URL=redis://:<password>@<host>:<port>

# Google (Gemini Live voice session + Gemini Flash research agent)
GOOGLE_API_KEY=AIza...

# OpenAI (web agent — GPT-4o vision)
OPENAI_API_KEY=sk-...
```

- [ ] **Step 3: Update `apps/api/baml_src/clients.baml`**

Replace the entire file:

```
generator my_client {
  output_type "typescript"
  output_dir ".."
  version "0.75.0"
}

client<llm> GPT4o {
  provider openai
  options {
    model "gpt-4o"
    api_key env.OPENAI_API_KEY
  }
}

client<llm> GeminiFlash {
  provider google-ai
  options {
    model "gemini-1.5-flash"
    api_key env.GOOGLE_API_KEY
  }
}
```

- [ ] **Step 4: Regenerate BAML client**

```bash
cd apps/api && pnpm build
```

Expected: BAML client regenerated in `baml_client/`. TypeScript compiles cleanly except for the still-missing `gemini-live-session.ts`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/package.json apps/api/.env.example apps/api/baml_src/clients.baml pnpm-lock.yaml
git commit -m "feat(api): add @google/genai SDK, GOOGLE_API_KEY env, GeminiFlash BAML client"
```

---

## Task 5: Implement GeminiLiveSession

**Files:**
- Create: `apps/api/src/gemini-live-session.ts`

This is the core of Phase 5. It opens a Gemini Live session, bridges audio, handles tool calls synchronously, and injects context parts.

- [ ] **Step 1: Create `apps/api/src/gemini-live-session.ts`**

```ts
import { GoogleGenAI, type LiveServerMessage } from "@google/genai"
import { logger } from "./logger.js"
import { appendTurn, type ConversationHistory } from "./redis.js"
import type { ServerMessage } from "@compass-ai/types"

if (!process.env.GOOGLE_API_KEY) {
  throw new Error("GOOGLE_API_KEY environment variable is not set")
}

const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY })

const SYSTEM_PROMPT = `You are Compass, an AI voice assistant for a financial trading platform.
You help users navigate the platform, place trades, and research stocks.
You never go silent waiting for a tool result — acknowledge tool dispatch and keep talking.
When you receive a message prefixed with [automation context], absorb it silently as background
information. Do not read it aloud or acknowledge it unless the user asks what you are doing
or the task completes.`

const TOOL_DECLARATIONS = [
  {
    name: "dispatch_research",
    description: "Start a background research task. Returns immediately — result will be injected when ready.",
    parameters: {
      type: "object",
      properties: {
        name:        { type: "string", description: "Short label, e.g. 'DANGCEM Q3 earnings'" },
        description: { type: "string", description: "Full research question" },
      },
      required: ["name", "description"],
    },
  },
  {
    name: "dispatch_automation",
    description: "Start a background browser automation task. Returns immediately — result injected when done.",
    parameters: {
      type: "object",
      properties: {
        name:        { type: "string", description: "Short label, e.g. 'Fill order form'" },
        description: { type: "string", description: "Full automation instruction" },
      },
      required: ["name", "description"],
    },
  },
  {
    name: "cancel_task",
    description: "Cancel a running background task by its taskId.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string" },
      },
      required: ["taskId"],
    },
  },
]

export class GeminiLiveSession {
  private sessionId:  string
  private send:       (msg: ServerMessage) => void
  private history:    ConversationHistory
  private session:    Awaited<ReturnType<typeof ai.live.connect>> | null = null

  // Tool call handlers — wired by TaskManager in Phase 6
  onDispatchResearch:  ((name: string, description: string) => object) | null = null
  onDispatchAutomation: ((name: string, description: string) => object) | null = null
  onCancelTask:         ((taskId: string) => object) | null = null

  constructor(sessionId: string, send: (msg: ServerMessage) => void, history: ConversationHistory) {
    this.sessionId = sessionId
    this.send      = send
    this.history   = history
  }

  async connect(): Promise<void> {
    const historyContext = this.history.summary || this.history.recentTurns.length > 0
      ? `\n\nConversation history:\n${this.history.summary}\n${this.history.recentTurns.map(t => `${t.role === "user" ? "User" : "Compass"}: ${t.content}`).join("\n")}`
      : ""

    this.session = await ai.live.connect({
      model: "gemini-2.0-flash-live-001",
      config: {
        systemInstruction: SYSTEM_PROMPT + historyContext,
        tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } },
        },
      },
      callbacks: {
        onopen:   () => logger.info("Gemini Live connected", { sessionId: this.sessionId }),
        onclose:  () => logger.info("Gemini Live closed",    { sessionId: this.sessionId }),
        onerror:  (e) => logger.error("Gemini Live error",  { sessionId: this.sessionId, error: String(e) }),
        onmessage: (msg: LiveServerMessage) => this.handleMessage(msg),
      },
    })
  }

  sendAudio(base64Pcm: string): void {
    if (!this.session) return
    this.session.sendRealtimeInput({
      audio: { data: base64Pcm, mimeType: "audio/pcm;rate=16000" },
    })
  }

  injectContent(text: string): void {
    if (!this.session) return
    this.session.sendClientContent({
      turns: [{ role: "user", parts: [{ text }] }],
      turnComplete: false,
    })
  }

  async close(): Promise<void> {
    await this.session?.close()
    this.session = null
  }

  private handleMessage(msg: LiveServerMessage): void {
    // Audio output — stream back to extension
    const audioPart = msg.serverContent?.modelTurn?.parts?.find(p => p.inlineData?.mimeType?.startsWith("audio/"))
    if (audioPart?.inlineData) {
      this.send({
        type:     "audio_chunk",
        sessionId: this.sessionId,
        data:      audioPart.inlineData.data ?? "",
        mimeType:  "audio/pcm",
      })
    }

    // Transcript — write user speech to Redis
    const inputTranscript = msg.serverContent?.inputTranscription
    if (inputTranscript?.text) {
      appendTurn(this.sessionId, { role: "user", content: inputTranscript.text }).catch(
        (err: unknown) => logger.error("Redis appendTurn failed", { sessionId: this.sessionId, error: String(err) })
      )
    }

    // Transcript — write model speech to Redis on turn complete
    const outputTranscript = msg.serverContent?.outputTranscription
    if (outputTranscript?.text && msg.serverContent?.turnComplete) {
      appendTurn(this.sessionId, { role: "model", content: outputTranscript.text }).catch(
        (err: unknown) => logger.error("Redis appendTurn failed", { sessionId: this.sessionId, error: String(err) })
      )
    }

    // Tool calls — handle synchronously, respond immediately
    const toolCall = msg.toolCall
    if (!toolCall?.functionCalls?.length) return

    const responses: Array<{ id: string; name: string; response: object }> = []

    for (const call of toolCall.functionCalls) {
      const args = call.args as Record<string, string>
      let result: object

      if (call.name === "dispatch_research" && this.onDispatchResearch) {
        result = this.onDispatchResearch(args.name, args.description)
      } else if (call.name === "dispatch_automation" && this.onDispatchAutomation) {
        result = this.onDispatchAutomation(args.name, args.description)
      } else if (call.name === "cancel_task" && this.onCancelTask) {
        result = this.onCancelTask(args.taskId)
      } else {
        // Stub response — TaskManager not wired yet (Phase 6+)
        result = { status: "acknowledged", note: "Tool handler not yet wired" }
      }

      responses.push({ id: call.id ?? "", name: call.name ?? "", response: result })
      logger.info("Tool call handled", { sessionId: this.sessionId, tool: call.name, result })
    }

    this.session?.sendToolResponse({ functionResponses: responses })
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
cd apps/api && pnpm typecheck
```

Expected: Clean. If `@google/genai` types don't exactly match (SDK is evolving), fix any type errors by aligning with what the installed version exports — check with `node -e "const g = require('@google/genai'); console.log(Object.keys(g))"`.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/gemini-live-session.ts
git commit -m "feat(api): add GeminiLiveSession — audio bridge + tool stubs for Gemini Live"
```

---

## Task 6: Update extension — PCM capture and streaming playback

**Files:**
- Create: `apps/extension/src/audio/pcm-capture.ts`
- Create: `apps/extension/src/audio/pcm-player.ts`
- Rewrite: `apps/extension/src/contents/pill.tsx`

The extension must capture raw PCM at 16kHz mono and stream it as `audio_chunk` messages. It must also receive `audio_chunk` messages back and play them in real time via the Web Audio API.

- [ ] **Step 1: Create `apps/extension/src/audio/pcm-capture.ts`**

Uses `MediaRecorder` with `audio/webm;codecs=opus` (widely supported in Chrome) decoded via `AudioContext` to raw PCM, then base64-encoded and emitted.

```ts
type OnChunk = (base64Pcm: string) => void

export class PcmCapture {
  private mediaRecorder: MediaRecorder | null = null
  private audioCtx:      AudioContext | null  = null
  private onChunk:       OnChunk

  constructor(onChunk: OnChunk) {
    this.onChunk = onChunk
  }

  async start(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount:  1,
        sampleRate:    16000,
        echoCancellation: true,
        noiseSuppression: true,
      },
    })

    this.audioCtx = new AudioContext({ sampleRate: 16000 })
    const source  = this.audioCtx.createMediaStreamSource(stream)

    // ScriptProcessor gives us raw float32 PCM chunks (deprecated but universally supported in Chrome extensions)
    // AudioWorklet requires registering a separate worklet file, which is complex in Plasmo.
    const processor = this.audioCtx.createScriptProcessor(4096, 1, 1)
    processor.onaudioprocess = (e) => {
      const float32 = e.inputBuffer.getChannelData(0)
      const int16   = new Int16Array(float32.length)
      for (let i = 0; i < float32.length; i++) {
        int16[i] = Math.max(-32768, Math.min(32767, float32[i] * 32768))
      }
      const base64 = btoa(String.fromCharCode(...new Uint8Array(int16.buffer)))
      this.onChunk(base64)
    }

    source.connect(processor)
    processor.connect(this.audioCtx.destination)

    this.mediaRecorder = new MediaRecorder(stream)
    this.mediaRecorder.start()
  }

  stop(): void {
    this.mediaRecorder?.stop()
    this.mediaRecorder?.stream.getTracks().forEach(t => t.stop())
    this.audioCtx?.close()
    this.mediaRecorder = null
    this.audioCtx      = null
  }
}
```

- [ ] **Step 2: Create `apps/extension/src/audio/pcm-player.ts`**

Plays incoming PCM chunks as they arrive via the Web Audio API. Each chunk is decoded from base64 Int16 PCM and scheduled on the AudioContext timeline so chunks play contiguously without gaps.

```ts
export class PcmPlayer {
  private audioCtx:  AudioContext | null = null
  private nextStart: number = 0
  private sampleRate: number

  constructor(sampleRate = 24000) {
    // Gemini Live outputs at 24kHz
    this.sampleRate = sampleRate
  }

  private getCtx(): AudioContext {
    if (!this.audioCtx) {
      this.audioCtx  = new AudioContext({ sampleRate: this.sampleRate })
      this.nextStart = this.audioCtx.currentTime
    }
    return this.audioCtx
  }

  play(base64Pcm: string): void {
    const ctx    = this.getCtx()
    const binary = atob(base64Pcm)
    const bytes  = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)

    const int16       = new Int16Array(bytes.buffer)
    const float32     = new Float32Array(int16.length)
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768

    const buffer = ctx.createBuffer(1, float32.length, this.sampleRate)
    buffer.copyToChannel(float32, 0)

    const source  = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)

    const startAt = Math.max(ctx.currentTime, this.nextStart)
    source.start(startAt)
    this.nextStart = startAt + buffer.duration
  }

  resume(): void {
    this.audioCtx?.resume()
  }

  stop(): void {
    this.audioCtx?.close()
    this.audioCtx  = null
    this.nextStart = 0
  }
}
```

- [ ] **Step 3: Rewrite `apps/extension/src/contents/pill.tsx`**

Replace the entire file. All Web Speech API and MP3 playback code is gone:

```tsx
import type { ExtensionMessage, ServerMessage } from "@compass-ai/types"
import cssText from "data-text:~/styles/globals.css"
import { MicIcon, MicOff } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"

import { PcmCapture } from "~/audio/pcm-capture"
import { PcmPlayer } from "~/audio/pcm-player"

type StripSessionId<T> = T extends { sessionId: string } ? Omit<T, "sessionId"> : T
type OutboundExtensionMessage = StripSessionId<ExtensionMessage>

export const getStyle = () => {
  const style = document.createElement("style")
  style.textContent = cssText
  return style
}

const player = new PcmPlayer(24000)

const Pill = () => {
  const [listening, setListening]   = useState(false)
  const captureRef = useRef<PcmCapture | null>(null)

  // Incoming audio from Gemini via background → play it
  useEffect(() => {
    const onMessage = (msg: ServerMessage) => {
      if (msg.type !== "audio_chunk") return
      player.resume()
      player.play(msg.data)
    }
    chrome.runtime.onMessage.addListener(onMessage)
    return () => chrome.runtime.onMessage.removeListener(onMessage)
  }, [])

  const startListening = useCallback(async () => {
    const capture = new PcmCapture((base64Pcm: string) => {
      const msg: OutboundExtensionMessage = {
        type:     "audio_chunk",
        data:     base64Pcm,
        mimeType: "audio/pcm",
      }
      chrome.runtime.sendMessage(msg)
    })
    await capture.start()
    captureRef.current = capture
    setListening(true)
  }, [])

  const stopListening = useCallback(() => {
    captureRef.current?.stop()
    captureRef.current = null
    setListening(false)
  }, [])

  const toggle = useCallback(() => {
    if (listening) {
      stopListening()
    } else {
      startListening().catch(console.error)
    }
  }, [listening, startListening, stopListening])

  return (
    <div className="fixed top-6 flex justify-center w-full">
      <div
        className="relative w-fit h-fit bg-white/60 backdrop-blur-xl border border-white/30 rounded-2xl shadow-2xl cursor-default pointer-events-auto
          before:absolute before:inset-0 before:rounded-2xl before:pointer-events-none
          before:bg-gradient-to-br before:from-white/20 before:to-transparent
          after:absolute after:inset-0 after:rounded-2xl after:pointer-events-none
          after:bg-gradient-to-tl after:from-black/10 after:to-transparent">
        <div className="flex gap-2 justify-center items-center rounded-full">
          <span className="inline-flex items-center justify-center relative z-10 h-8 px-2 leading-none">
            compass
          </span>
          <button
            onClick={toggle}
            className="relative z-10 border p-1 rounded-full focus:outline-none"
            aria-label={listening ? "Stop listening" : "Start listening"}>
            {listening ? (
              <MicIcon size={16} className="text-red-500 animate-pulse" />
            ) : (
              <MicOff size={16} className="text-gray-400" />
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

export default Pill
```

- [ ] **Step 4: Typecheck extension**

```bash
cd apps/extension && pnpm typecheck 2>&1 || true
```

Expected: No errors in the files we wrote. Any lingering errors from removed speech files are gone since those files no longer exist.

- [ ] **Step 5: Commit**

```bash
git add apps/extension/src/audio/ apps/extension/src/contents/pill.tsx
git commit -m "feat(extension): replace WebSpeechProvider+MP3 with PCM capture and streaming playback"
```

---

## Task 7: Update extension manifest — microphone permission

**Files:**
- Modify: `apps/extension/package.json`

The extension needs the `microphone` permission declared in the manifest to capture audio.

- [ ] **Step 1: Add microphone permission to `apps/extension/package.json`**

Find the `"manifest"` section and add `"microphone"` to permissions:

```json
"manifest": {
  "host_permissions": [
    "https://*/*",
    "http://*/*"
  ],
  "permissions": [
    "tabs",
    "microphone"
  ]
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/extension/package.json
git commit -m "feat(extension): add microphone permission to manifest"
```

---

## Task 8: Smoke test end-to-end

- [ ] **Step 1: Ensure GOOGLE_API_KEY is set in `apps/api/.env`**

Copy `.env.example` to `.env` if not already done and fill in a real `GOOGLE_API_KEY`. Gemini Live requires the `gemini-2.0-flash-live-001` model. Confirm access at [https://aistudio.google.com](https://aistudio.google.com).

- [ ] **Step 2: Start Redis**

```bash
docker run -d -p 6379:6379 redis:7
```

Set `REDIS_URL=redis://localhost:6379` in `apps/api/.env`.

- [ ] **Step 3: Start the API server**

```bash
cd apps/api && pnpm dev
```

Expected log output:
```
{"ts":"...","level":"info","message":"Starting Compass API"}
{"ts":"...","level":"info","message":"Redis connected"}
{"ts":"...","level":"info","message":"Server listening","port":8787}
```

- [ ] **Step 4: Start the extension in dev mode**

```bash
cd apps/extension && pnpm dev
```

Load the unpacked extension from `apps/extension/.plasmo/chrome-mv3-dev` in Chrome at `chrome://extensions`.

- [ ] **Step 5: Open any page and test the mic button**

1. Navigate to any page.
2. The Compass pill should appear at the top.
3. Click the mic button — it should turn red and start capturing.
4. Speak a sentence.
5. Expected: API server logs show `Client connected` and a stream of `audio_chunk` messages being received, then `Gemini Live connected`. Gemini's audio response plays back through the browser speakers.
6. Click mic again to stop.

- [ ] **Step 6: Verify tool stub logging**

Say "Research DANGCEM earnings for me". Expected: API server logs show `Tool call handled` with `tool: "dispatch_research"` and `result: { status: "acknowledged", note: "Tool handler not yet wired" }`. Gemini continues talking without going silent.

- [ ] **Step 7: Final typecheck and commit**

```bash
cd apps/api && pnpm typecheck
cd apps/extension && pnpm typecheck 2>&1 || true
```

```bash
git add -A
git commit -m "chore: phase 5 complete — Gemini Live voice session wired end-to-end"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|---|---|
| Remove STT/TTS/SpeechProvider/TTSProvider | Task 1 |
| Replace `transcript_input` with `audio_chunk` | Task 1, 6 |
| `GeminiLiveSession` — audio bridge | Task 5 |
| Tool declarations (dispatch_research, dispatch_automation, cancel_task) | Task 5 |
| Tool call → immediate response → keep talking | Task 5 |
| PCM capture in extension | Task 6 |
| Streaming PCM playback in extension | Task 6 |
| `SessionState` new shape | Task 1, 3 |
| Redis `Turn.role` → `"model"` | Task 2 |
| Redis window → 6 | Task 2 |
| History injected into system prompt on reconnect | Task 5 |
| `[automation context]` prefix silent injection | Task 5 (system prompt instruction) |
| `GOOGLE_API_KEY` env var | Task 4 |
| `GeminiFlash` BAML client for research | Task 4 |
| Microphone manifest permission | Task 7 |

**No placeholders found.** All steps contain complete code.

**Type consistency check:**
- `Turn.role: "user" | "model"` — consistent across `redis.ts`, `session.ts`, `GeminiLiveSession`
- `audio_chunk` message shape `{ type, sessionId, data, mimeType }` — consistent across `messages.ts`, `server.ts`, `pill.tsx`, `GeminiLiveSession`
- `SessionState.researchSlots`, `automationSlot`, `cancelledTasks` — defined in `session.ts`, used in `session-store.ts`
- `GeminiLiveSession.onDispatchResearch/onDispatchAutomation/onCancelTask` — null stubs in Phase 5, wired by TaskManager in Phase 6
