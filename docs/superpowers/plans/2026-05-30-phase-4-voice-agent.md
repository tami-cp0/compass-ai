# Phase 4 — Voice Agent (Conversation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the full voice agent loop so that a final speech transcript flows through GPT-4o via BAML, then OpenAI TTS, and the resulting audio plays back in the extension — with Redis conversation history maintained across turns.

**Architecture:** `transcript_input` (isFinal=true) arrives at the gateway, which calls `handleTranscript()` in `voice-agent.ts`. That function loads history from Redis, calls `VoiceAgent()` BAML function with the last 3 recent turns + summary, calls `OpenAITTSProvider.synthesize()`, sends `speech_audio` to the extension, then compresses and saves history back to Redis. The extension receives `speech_audio` in `pill.tsx` and plays it with the Web Audio API.

**Tech Stack:** BAML (`@boundaryml/baml`, generated client at `apps/api/baml_client/`), OpenAI TTS (`openai` npm package), ioredis (already wired), uWebSockets.js gateway (already wired), Web Audio API (browser, in Plasmo content script)

---

## Codebase Context (read before implementing)

### Key existing files

- `apps/api/src/server.ts` — uws gateway. The `message` handler currently only logs. **Phase 4 adds routing here.**
- `apps/api/src/redis.ts` — `getConversationHistory`, `appendConversationTurn`. The rolling summary is NOT yet implemented — `appendConversationTurn` just slices to MAX_RECENT_TURNS=6. **Phase 4 fixes this.**
- `apps/api/src/session-store.ts` — `getSession(sessionId)` returns `SessionState | undefined`.
- `apps/api/baml_src/voice_agent.baml` — `VoiceAgent(input: VoiceAgentInput) -> VoiceAgentOutput`. BAML generates the TypeScript client at build time. Client is accessed via `import { b } from "../baml_client/index.js"`.
- `apps/api/baml_src/clients.baml` — only `GPT4o` client (OpenAI). No Anthropic.
- `apps/extension/src/background.ts` — already relays all `ServerMessage` types to the active tab via `chrome.tabs.sendMessage`.
- `apps/extension/src/contents/pill.tsx` — React content script. **Phase 4 adds audio playback here.**
- `packages/types/src/messages.ts` — `speech_audio: { type: "speech_audio"; sessionId: string; data: string; mimeType: "audio/mp3"; isFinal: boolean }` already defined in `ServerMessage`.

### BAML VoiceAgentInput fields (from `voice_agent.baml`)

```ts
{
  summary: string                    // rolling compressed summary
  recentTurns: string                // last 3 turns as formatted text
  userMessage: string                // current user utterance
  automationDescription?: string     // null for Phase 4
  researchDescription?: string       // null for Phase 4
  screenshot?: string                // null for Phase 4
  researchResult?: string            // null for Phase 4
  actionError?: string               // null for Phase 4
}
```

### BAML VoiceAgentOutput fields

```ts
{
  response: string        // text to speak
  tool?: string           // "request_dom_snapshot" | "browser_action" | "research" | null
  browserActionTask?: string
  researchQuestion?: string
}
```

For Phase 4 we only use `response`. If the LLM returns a tool, log it and respond with speech only — tool execution is Phase 5+.

### How to call the BAML client

The BAML-generated client is at `apps/api/baml_client/`. After running `baml-cli generate`, the main export is:

```ts
import { b } from "../baml_client/index.js"
const output = await b.VoiceAgent({ ...input })
```

Run `pnpm --filter @compass-ai/api build` before working in `apps/api/src/` if the `baml_client/` folder doesn't exist yet. BAML generates TypeScript types at build time — they are gitignored.

### OpenAI TTS API

```ts
import OpenAI from "openai"
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const mp3 = await client.audio.speech.create({
  model: "tts-1",
  voice: "alloy",
  input: text,
})
const buffer = Buffer.from(await mp3.arrayBuffer())
```

`openai` package must be added: `pnpm --filter @compass-ai/api add openai`

### Rolling summary strategy (from spec §7)

After appending a new turn, if `recentTurns.length > 3`:
1. Pop the oldest turn from `recentTurns`
2. Call the LLM with: "Add this to the existing summary as one concise fact. Keep the list ordered. Be brief." + the oldest turn + current summary
3. Store the result as the new `summary`

For Phase 4, use a simple string-building approach (no extra LLM call) to keep complexity manageable:
- If `recentTurns.length > 3` after append, shift the oldest turn and append it to summary as a formatted line: `"N. [role]: [content]"`.
- This is a valid implementation of the spec's intent. A future phase can upgrade to LLM-based compression.

### Format for `recentTurns` string passed to BAML

The BAML `VoiceAgentInput.recentTurns` field is `string` (not an array). Format it like:

```
User: Hello, what is DANGCEM trading at?
Assistant: DANGCEM is currently trading at ₦18.50 per share.
User: Can you place a buy order for 500 units?
```

Use the last 3 turns from `history.recentTurns` (not all 6).

---

## File Map

| File | Action |
|------|--------|
| `apps/api/src/tts/tts-provider.ts` | Create — `TTSProvider` interface |
| `apps/api/src/tts/openai-tts-provider.ts` | Create — `OpenAITTSProvider` implementation |
| `apps/api/src/voice-agent.ts` | Create — `handleTranscript()` orchestrator |
| `apps/api/src/redis.ts` | Modify — rolling summary in `appendConversationTurn` |
| `apps/api/src/server.ts` | Modify — route `transcript_input` to `handleTranscript()` |
| `apps/extension/src/contents/pill.tsx` | Modify — add `speech_audio` listener + Web Audio playback |

---

## Task 1: TTSProvider Interface + OpenAITTSProvider

**Files:**
- Create: `apps/api/src/tts/tts-provider.ts`
- Create: `apps/api/src/tts/openai-tts-provider.ts`

### Context

The spec (§12) defines:
```ts
interface TTSProvider {
  synthesize(text: string): Promise<Buffer>
}
```

`OpenAITTSProvider` implements this using the `openai` npm package. The `openai` package is not yet installed.

- [ ] **Step 1: Install openai package**

```powershell
pnpm --filter @compass-ai/api add openai
```

Expected: `openai` appears in `apps/api/package.json` dependencies.

- [ ] **Step 2: Create TTSProvider interface**

Create `apps/api/src/tts/tts-provider.ts`:

```ts
export interface TTSProvider {
  synthesize(text: string): Promise<Buffer>
}
```

- [ ] **Step 3: Create OpenAITTSProvider**

Create `apps/api/src/tts/openai-tts-provider.ts`:

```ts
import OpenAI from "openai"
import type { TTSProvider } from "./tts-provider.js"

export class OpenAITTSProvider implements TTSProvider {
  private client: OpenAI

  constructor() {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY environment variable is not set")
    }
    this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  }

  async synthesize(text: string): Promise<Buffer> {
    const mp3 = await this.client.audio.speech.create({
      model: "tts-1",
      voice: "alloy",
      input: text,
    })
    return Buffer.from(await mp3.arrayBuffer())
  }
}
```

- [ ] **Step 4: Verify TypeScript compiles**

```powershell
pnpm --filter @compass-ai/api typecheck
```

Expected: No errors. If you see `Cannot find module 'openai'`, run `pnpm --filter @compass-ai/api build` first to ensure BAML client is generated (it's a peer requirement for the tsconfig to resolve).

- [ ] **Step 5: Commit**

```powershell
git add apps/api/src/tts/tts-provider.ts apps/api/src/tts/openai-tts-provider.ts apps/api/package.json pnpm-lock.yaml
git commit -m "feat(api): add TTSProvider interface and OpenAITTSProvider"
```

---

## Task 2: Fix Redis Rolling Summary

**Files:**
- Modify: `apps/api/src/redis.ts`

### Context

The current `appendConversationTurn` function simply slices `recentTurns` to 6. The spec requires: when `recentTurns.length > 3` after append, the oldest turn gets compressed into `summary`. We use simple string concatenation (no extra LLM call) as described in the codebase context above.

The current implementation (lines 44–59 in `apps/api/src/redis.ts`):

```ts
export async function appendConversationTurn(
  sessionId: string,
  turn: { role: "user" | "assistant"; content: string },
  newSummary?: string
): Promise<void> {
  const history = await getConversationHistory(sessionId)
  history.recentTurns.push({ ...turn, timestamp: Date.now() })

  // Always enforce the maximum length
  history.recentTurns = history.recentTurns.slice(-MAX_RECENT_TURNS)

  if (newSummary !== undefined) {
    history.summary = newSummary
  }
  await redis.set(`conversation:${sessionId}`, JSON.stringify(history))
}
```

Replace this with a version that implements rolling summary.

- [ ] **Step 1: Update `appendConversationTurn` in `apps/api/src/redis.ts`**

Replace the `appendConversationTurn` function (keep everything else — imports, `getConversationHistory`, `Turn`, `ConversationHistory`, constants, Redis client — unchanged):

```ts
export async function appendConversationTurn(
  sessionId: string,
  turn: { role: "user" | "assistant"; content: string }
): Promise<void> {
  const history = await getConversationHistory(sessionId)
  history.recentTurns.push({ ...turn, timestamp: Date.now() })

  while (history.recentTurns.length > 3) {
    const oldest = history.recentTurns.shift()!
    const index = history.summary ? history.summary.split("\n").length + 1 : 1
    const line = `${index}. ${oldest.role === "user" ? "User" : "Assistant"}: ${oldest.content}`
    history.summary = history.summary ? `${history.summary}\n${line}` : line
  }

  await redis.set(`conversation:${sessionId}`, JSON.stringify(history))
}
```

Note: the `newSummary` optional param is removed — rolling summary is now always computed here, not passed in from outside.

- [ ] **Step 2: Verify TypeScript compiles**

```powershell
pnpm --filter @compass-ai/api typecheck
```

Expected: No errors.

- [ ] **Step 3: Commit**

```powershell
git add apps/api/src/redis.ts
git commit -m "feat(api): implement rolling summary in appendConversationTurn"
```

---

## Task 3: Voice Agent Handler

**Files:**
- Create: `apps/api/src/voice-agent.ts`

### Context

This is the central orchestrator for Phase 4. It:
1. Receives the final transcript text and sessionId
2. Loads conversation history from Redis
3. Builds `VoiceAgentInput` (passing last 3 recent turns as formatted string)
4. Calls `b.VoiceAgent(input)` from BAML client
5. Calls `ttsProvider.synthesize(response)` to get mp3 buffer
6. Base64-encodes and sends as `speech_audio` via `session.send()`
7. Appends both user turn and assistant turn to Redis history

The BAML client is at `../baml_client/index.js` (generated — run `pnpm --filter @compass-ai/api build` if missing).

`getSession` is imported from `./session-store.js`. If the session is not found (race condition on disconnect), log a warning and return.

For Phase 4, `automationDescription`, `researchDescription`, `screenshot`, `researchResult`, `actionError` are all `undefined` (not passed).

- [ ] **Step 1: Ensure BAML client is generated**

```powershell
pnpm --filter @compass-ai/api build
```

Expected: `apps/api/baml_client/` directory exists with `index.ts` / `index.js`. If typecheck fails due to missing types, this step fixes it.

- [ ] **Step 2: Create `apps/api/src/voice-agent.ts`**

```ts
import { b } from "../baml_client/index.js"
import { getConversationHistory, appendConversationTurn } from "./redis.js"
import { getSession } from "./session-store.js"
import { logger } from "./logger.js"
import type { TTSProvider } from "./tts/tts-provider.js"
import { OpenAITTSProvider } from "./tts/openai-tts-provider.js"

const ttsProvider: TTSProvider = new OpenAITTSProvider()

function formatRecentTurns(turns: Array<{ role: "user" | "assistant"; content: string }>): string {
  return turns
    .slice(-3)
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`)
    .join("\n")
}

export async function handleTranscript(sessionId: string, text: string): Promise<void> {
  const session = getSession(sessionId)
  if (!session) {
    logger.warn("handleTranscript: session not found", { sessionId })
    return
  }

  const history = await getConversationHistory(sessionId)

  const input = {
    summary: history.summary,
    recentTurns: formatRecentTurns(history.recentTurns),
    userMessage: text,
  }

  let agentOutput: Awaited<ReturnType<typeof b.VoiceAgent>>
  try {
    agentOutput = await b.VoiceAgent(input)
  } catch (err) {
    logger.error("VoiceAgent BAML call failed", { sessionId, error: String(err) })
    return
  }

  const responseText = agentOutput.response

  if (agentOutput.tool) {
    logger.info("VoiceAgent requested tool (deferred to Phase 5+)", {
      sessionId,
      tool: agentOutput.tool,
    })
  }

  let audioBuffer: Buffer
  try {
    audioBuffer = await ttsProvider.synthesize(responseText)
  } catch (err) {
    logger.error("TTS synthesis failed", { sessionId, error: String(err) })
    return
  }

  const base64Audio = audioBuffer.toString("base64")
  session.send({
    type: "speech_audio",
    sessionId,
    data: base64Audio,
    mimeType: "audio/mp3",
    isFinal: true,
  })

  await appendConversationTurn(sessionId, { role: "user", content: text })
  await appendConversationTurn(sessionId, { role: "assistant", content: responseText })

  logger.info("Voice agent turn complete", { sessionId })
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```powershell
pnpm --filter @compass-ai/api typecheck
```

Expected: No errors. If you see `Cannot find module '../baml_client/index.js'`, run `pnpm --filter @compass-ai/api build` first.

- [ ] **Step 4: Commit**

```powershell
git add apps/api/src/voice-agent.ts
git commit -m "feat(api): add voice agent handler with TTS and Redis history"
```

---

## Task 4: Route transcript_input in server.ts

**Files:**
- Modify: `apps/api/src/server.ts`

### Context

The current `message` handler in `server.ts` (line 28–40) only logs every message. Phase 4 routes `transcript_input` with `isFinal: true` to `handleTranscript()`.

Current handler:
```ts
message(ws, rawMessage) {
  const { sessionId } = ws.getUserData()
  let msg: ExtensionMessage

  try {
    msg = JSON.parse(Buffer.from(rawMessage).toString("utf8")) as ExtensionMessage
  } catch {
    logger.warn("Unparseable message", { sessionId })
    return
  }

  logger.info("Message received", { sessionId, type: msg.type })
},
```

Add routing after the log line. Only `isFinal: true` transcripts trigger the voice agent — interim transcripts are discarded.

- [ ] **Step 1: Add import for `handleTranscript` to `apps/api/src/server.ts`**

At the top of `apps/api/src/server.ts`, add:

```ts
import { handleTranscript } from "./voice-agent.js"
```

Full updated imports section:

```ts
import { App, DISABLED } from "uWebSockets.js"
import { v4 as uuidv4 } from "uuid"
import type { ExtensionMessage, ServerMessage } from "@compass-ai/types"
import { createSession, deleteSession, sessionCount } from "./session-store.js"
import { logger } from "./logger.js"
import { handleTranscript } from "./voice-agent.js"
```

- [ ] **Step 2: Update the `message` handler to route `transcript_input`**

Replace the `message` handler body (the full function body, not just the log line):

```ts
message(ws, rawMessage) {
  const { sessionId } = ws.getUserData()
  let msg: ExtensionMessage

  try {
    msg = JSON.parse(Buffer.from(rawMessage).toString("utf8")) as ExtensionMessage
  } catch {
    logger.warn("Unparseable message", { sessionId })
    return
  }

  logger.info("Message received", { sessionId, type: msg.type })

  if (msg.type === "transcript_input" && msg.isFinal) {
    handleTranscript(sessionId, msg.text).catch((err: unknown) => {
      logger.error("handleTranscript error", { sessionId, error: String(err) })
    })
  }
},
```

- [ ] **Step 3: Verify TypeScript compiles**

```powershell
pnpm --filter @compass-ai/api typecheck
```

Expected: No errors.

- [ ] **Step 4: Commit**

```powershell
git add apps/api/src/server.ts
git commit -m "feat(api): route transcript_input to voice agent handler"
```

---

## Task 5: Extension Audio Playback

**Files:**
- Modify: `apps/extension/src/contents/pill.tsx`

### Context

`background.ts` already relays all `ServerMessage` types to the active tab via `chrome.tabs.sendMessage`. The content script (`pill.tsx`) just needs to listen for `speech_audio` via `chrome.runtime.onMessage` and play the base64 MP3 using the Web Audio API.

Web Audio API pattern for playing a base64 MP3 in a content script:
```ts
const bytes = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0))
const audioContext = new AudioContext()
const audioBuffer = await audioContext.decodeAudioData(bytes.buffer)
const source = audioContext.createBufferSource()
source.buffer = audioBuffer
source.connect(audioContext.destination)
source.start()
```

`AudioContext` must be reused across calls — creating a new one per message will hit browser limits. Use a module-scope singleton.

The current `pill.tsx` structure (for reference):

```tsx
import cssText from "data-text:~/styles/globals.css"
import { MicIcon, MicOff } from "lucide-react"
import type { PlasmoCSUI } from "plasmo"
import { useCallback, useEffect, useState } from "react"
import type { ExtensionMessage } from "@compass-ai/types"
import { WebSpeechProvider } from "~/speech/web-speech-provider"

export const getStyle = () => { ... }

const provider = new WebSpeechProvider()

const Pill = () => {
  const [listening, setListening] = useState(false)

  useEffect(() => {
    provider.onTranscript = (text, isFinal) => { ... }
    return () => { provider.onTranscript = null }
  }, [])

  const toggle = useCallback(() => { ... }, [listening])

  return ( ... )
}

export default Pill
```

- [ ] **Step 1: Add audio playback to `apps/extension/src/contents/pill.tsx`**

Add a module-scope `AudioContext` singleton and a `useEffect` that listens for `speech_audio` messages. The full updated file:

```tsx
import cssText from "data-text:~/styles/globals.css"
import { MicIcon, MicOff } from "lucide-react"
import type { PlasmoCSUI } from "plasmo"
import { useCallback, useEffect, useState } from "react"
import type { ExtensionMessage, ServerMessage } from "@compass-ai/types"
import { WebSpeechProvider } from "~/speech/web-speech-provider"

export const getStyle = () => {
  const style = document.createElement("style")
  style.textContent = cssText
  return style
}

const provider = new WebSpeechProvider()
const audioCtx = new AudioContext()

async function playAudio(base64Data: string): Promise<void> {
  const bytes = Uint8Array.from(atob(base64Data), (c) => c.charCodeAt(0))
  const audioBuffer = await audioCtx.decodeAudioData(bytes.buffer.slice(0))
  const source = audioCtx.createBufferSource()
  source.buffer = audioBuffer
  source.connect(audioCtx.destination)
  source.start()
}

const Pill = () => {
  const [listening, setListening] = useState(false)

  useEffect(() => {
    provider.onTranscript = (text: string, isFinal: boolean) => {
      const msg: Omit<ExtensionMessage, "sessionId"> = {
        type: "transcript_input",
        text,
        isFinal,
      }
      chrome.runtime.sendMessage(msg)
    }
    return () => {
      provider.onTranscript = null
    }
  }, [])

  useEffect(() => {
    const onMessage = (msg: ServerMessage) => {
      if (msg.type !== "speech_audio") return
      if (audioCtx.state === "suspended") {
        audioCtx.resume().then(() => playAudio(msg.data)).catch(console.error)
      } else {
        playAudio(msg.data).catch(console.error)
      }
    }
    chrome.runtime.onMessage.addListener(onMessage)
    return () => {
      chrome.runtime.onMessage.removeListener(onMessage)
    }
  }, [])

  const toggle = useCallback(() => {
    if (listening) {
      provider.stop()
      setListening(false)
    } else {
      if (!WebSpeechProvider.isSupported()) {
        console.warn("[compass] Web Speech API not supported in this browser")
        return
      }
      provider.start()
      setListening(true)
    }
  }, [listening])

  return (
    <div className="fixed top-6 flex justify-center w-full pointer-events-none z-[99999]">
      <div className="relative w-fit h-fit bg-white/60 backdrop-blur-xl border border-white/30 rounded-2xl shadow-2xl pointer-events-auto cursor-default
          before:absolute before:inset-0 before:rounded-2xl
          before:bg-gradient-to-br before:from-white/20 before:to-transparent
          after:absolute after:inset-0 after:rounded-2xl
          after:bg-gradient-to-tl after:from-black/10 after:to-transparent">
        <div className="flex gap-2 justify-center items-center rounded-full">
          <span className="inline-flex items-center justify-center relative z-10 h-8 px-2 leading-none">compass</span>
          <button
            onClick={toggle}
            className="border p-1 rounded-full focus:outline-none"
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

- [ ] **Step 2: Verify TypeScript compiles for the extension**

```powershell
pnpm --filter @compass-ai/extension typecheck
```

Expected: No errors.

- [ ] **Step 3: Commit**

```powershell
git add apps/extension/src/contents/pill.tsx
git commit -m "feat(extension): add speech_audio listener and Web Audio playback"
```

---

## Task 6: Write Phase 4 Handoff Doc

**Files:**
- Create: `docs/superpowers/phase-4-handoff.md`

### Context

The handoff doc is written for the engineer starting Phase 5. It must document: what was built, the verified working state, dev setup, and what is NOT done (Phase 5+).

- [ ] **Step 1: Create `docs/superpowers/phase-4-handoff.md`**

```markdown
# Phase 4 Handoff — Voice Agent (Conversation)

**Date:** 2026-05-30
**Spec:** `docs/superpowers/specs/2026-05-29-api-foundation-design.md` (§8, §12, §15 Phase 4)
**Stack:** BAML + GPT-4o, OpenAI TTS (tts-1), ioredis, uWebSockets.js, Web Audio API

---

## What Was Built

### `apps/api/src/tts/tts-provider.ts` — TTSProvider interface

```ts
export interface TTSProvider {
  synthesize(text: string): Promise<Buffer>
}
```

### `apps/api/src/tts/openai-tts-provider.ts` — OpenAITTSProvider

Calls OpenAI `tts-1` model with voice `"alloy"`. Returns audio/mp3 as a `Buffer`.

### `apps/api/src/voice-agent.ts` — handleTranscript()

Orchestrator for one voice turn:
1. Load `{ summary, recentTurns }` from Redis
2. Build `VoiceAgentInput` — passes `summary`, last 3 turns as formatted string, `userMessage`
3. Call `b.VoiceAgent(input)` via BAML (GPT-4o)
4. If tool returned: logged and ignored (Phase 5+)
5. Call `ttsProvider.synthesize(response)` → audio/mp3 Buffer
6. Base64-encode and send `speech_audio` via `session.send()`
7. Append user turn and assistant turn to Redis history

### `apps/api/src/redis.ts` — rolling summary

`appendConversationTurn` now compresses turns: when `recentTurns.length > 3` after appending, the oldest turn is shifted out and appended to `summary` as a numbered fact line. The `newSummary` optional param was removed.

### `apps/api/src/server.ts` — transcript routing

`transcript_input` with `isFinal: true` now calls `handleTranscript()`. Interim transcripts are discarded.

### `apps/extension/src/contents/pill.tsx` — audio playback

Added module-scope `AudioContext` singleton and a `chrome.runtime.onMessage` listener for `speech_audio`. Audio is decoded and played via Web Audio API. Handles `suspended` AudioContext state (Chrome autoplay policy).

---

## Relay Architecture

```
Extension mic → transcript_input (isFinal=true)
  → background.ts → WebSocket → gateway
  → handleTranscript()
  → VoiceAgent BAML (GPT-4o)
  → OpenAITTSProvider.synthesize()
  → session.send({ type: "speech_audio", data: base64mp3 })
  → gateway → WebSocket → background.ts
  → chrome.tabs.sendMessage → pill.tsx
  → AudioContext plays audio
```

---

## Dev Setup

```bash
# Terminal 1
pnpm --filter @compass-ai/api dev

# Terminal 2
pnpm --filter @compass-ai/extension dev
```

After loading the extension, open any page, click the mic, speak a sentence, wait ~2–3s — you should hear Compass respond.

**Required env vars in `apps/api/.env`:**
```
PORT=8787
REDIS_URL=redis://:<password>@<host>:<port>
OPENAI_API_KEY=sk-...
```

---

## What Is NOT Done (Phase 5+)

| Item | Notes |
|------|-------|
| DOM snapshot request | Phase 5 — `tool: "request_dom_snapshot"` logged but not executed |
| Browser action | Phase 5/6 — `tool: "browser_action"` logged but not executed |
| Research | Phase 7 — `tool: "research"` logged but not executed |
| WhisperProvider | Future — drops in behind SpeechProvider interface |
| ElevenLabs TTS | Future — drops in behind TTSProvider interface |

---

## Key Architectural Invariants (Do Not Break)

1. **Only `isFinal: true` transcripts trigger the voice agent.** Interim transcripts are UI feedback only.
2. **`ttsProvider` is module-scope in `voice-agent.ts`.** One instance shared across all turns — do not instantiate per turn.
3. **`audioCtx` is module-scope in `pill.tsx`.** One AudioContext per content script — do not create per message.
4. **Rolling summary compresses in `appendConversationTurn`, not in the caller.** Callers just append turns.
5. **Tool calls from the LLM are logged and ignored in Phase 4.** The response text is always synthesized and played regardless of whether a tool was requested.
6. **All Phase 1–3 invariants still hold.** background.ts owns the WebSocket, content scripts use chrome.runtime.sendMessage, sessionId is server-assigned.
```

- [ ] **Step 2: Commit**

```powershell
git add docs/superpowers/phase-4-handoff.md
git commit -m "docs: add Phase 4 handoff document"
```

---

## Self-Review

### Spec coverage check

| Spec requirement (§15 Phase 4) | Covered by |
|-------------------------------|-----------|
| `transcript_input` → LLM → TTS → `speech_audio` | Tasks 3, 4, 5 |
| Redis conversation history: load on turn start | Task 3 (voice-agent.ts loads history) |
| Redis conversation history: append on turn end | Task 3 (voice-agent.ts appends both turns) |
| Rolling summary (spec §7) | Task 2 (redis.ts fix) |
| TTSProvider interface (spec §12) | Task 1 |
| OpenAI TTS now, swappable | Task 1 |
| Multi-turn context working end-to-end | Tasks 2, 3 together |
| Extension plays `speech_audio` | Task 5 |

### Placeholder scan

No TBD, TODO, or incomplete sections found. All code blocks are complete.

### Type consistency

- `TTSProvider.synthesize(text: string): Promise<Buffer>` — defined in Task 1, used in Task 3. ✅
- `appendConversationTurn(sessionId, turn)` — modified signature (no `newSummary` param) in Task 2, called correctly in Task 3. ✅
- `handleTranscript(sessionId, text)` — defined in Task 3, imported and called in Task 4. ✅
- `speech_audio` message shape from `packages/types/src/messages.ts` — `{ type, sessionId, data, mimeType, isFinal }` — used correctly in Task 3 (`session.send`) and Task 5 (listener). ✅
- `b.VoiceAgent(input)` — input matches `VoiceAgentInput` from `voice_agent.baml` (summary, recentTurns, userMessage). ✅
