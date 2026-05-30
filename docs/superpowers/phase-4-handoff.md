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

Future TTS providers (ElevenLabs, etc.) drop in by implementing this interface — one-line swap at instantiation.

---

### `apps/api/src/tts/openai-tts-provider.ts` — OpenAITTSProvider

Calls OpenAI `tts-1` model with voice `"alloy"`. Throws at construction time if `OPENAI_API_KEY` is absent. Returns audio/mp3 as a `Buffer`.

---

### `apps/api/src/voice-agent.ts` — handleTranscript()

Orchestrator for one voice turn. **Redis write ordering is intentional — do not reorder:**

1. `getSession(sessionId)` — returns early if session not found (race condition on disconnect)
2. `getConversationHistory(sessionId)` — load from Redis
3. `appendConversationTurn(sessionId, { role: "user", content: text })` — saved before BAML so the user utterance survives any downstream failure
4. Build `VoiceAgentInput` from the loaded history variable (not re-fetched)
5. `b.VoiceAgent(input)` via BAML (GPT-4o) — try/catch, logs error and returns on failure
6. Log if `tool` is set (deferred to Phase 5+)
7. `appendConversationTurn(sessionId, { role: "assistant", content: responseText })` — saved before TTS so model memory is preserved even if audio delivery fails
8. `getTTSProvider().synthesize(responseText)` — lazy singleton, try/catch, logs error and returns on failure
9. `session.send({ type: "speech_audio", data: base64mp3, mimeType: "audio/mp3", isFinal: true })`
10. Log "Voice agent turn complete"

**Lazy TTS singleton:** `ttsProvider` is initialized on first call, not at module scope. This prevents the process from crashing during import if `OPENAI_API_KEY` is missing — the error surfaces inside the existing try/catch.

**Tool calls from the LLM:** Logged and ignored in Phase 4. The `response` text is always synthesized and played regardless of whether a tool was requested.

---

### `apps/api/src/redis.ts` — rolling summary

`appendConversationTurn` now implements rolling summary compression. When `recentTurns.length > 3` after appending, the oldest turn is shifted out and appended to `summary` as a numbered fact line:

```
1. User: What is DANGCEM trading at?
2. Assistant: DANGCEM is currently at ₦18.50.
```

The `newSummary` optional parameter was removed — callers just append turns; compression is automatic.

---

### `apps/api/src/server.ts` — transcript routing

`transcript_input` with `isFinal: true` now calls `handleTranscript()`. Interim transcripts (`isFinal: false`) are discarded silently — they are STT interim results, not complete utterances.

---

### `apps/api/tsconfig.json` — BAML client include

`rootDir` updated to `"."` and `"baml_client/**/*.ts"` added to `include`. Required because the BAML-generated client lives at `apps/api/baml_client/` (a sibling of `src/`), not inside `src/`.

---

### `apps/extension/src/contents/pill.tsx` — audio playback

Added module-scope `AudioContext` singleton and a `chrome.runtime.onMessage` listener for `speech_audio`. Handles Chrome's autoplay policy: if `audioCtx.state === "suspended"`, calls `resume()` before playing. Uses `bytes.buffer.slice(0)` when calling `decodeAudioData` to prevent detached ArrayBuffer errors.

---

## Relay Architecture

```
Extension mic → transcript_input (isFinal=true)
  → background.ts → WebSocket → gateway
  → handleTranscript()
  → getConversationHistory (Redis)
  → appendConversationTurn user (Redis)
  → VoiceAgent BAML (GPT-4o)
  → appendConversationTurn assistant (Redis)
  → getTTSProvider().synthesize() (OpenAI TTS)
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

**BAML client:** Run `pnpm --filter @compass-ai/api build` once to generate `apps/api/baml_client/`. This folder is gitignored and must be generated before `dev` or `typecheck` will work.

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

1. **Only `isFinal: true` transcripts trigger the voice agent.** Interim transcripts are UI feedback only — the STT engine sends many of these before a final result.

2. **Redis write ordering: user turn → BAML → assistant turn → TTS → send.** This ordering ensures conversation history is durable even if audio delivery fails.

3. **`getTTSProvider()` is a lazy singleton in `voice-agent.ts`.** One instance shared across all turns — do not instantiate per turn or make it module-scope (to avoid crashing on missing env var at import time).

4. **`audioCtx` is module-scope in `pill.tsx`.** One AudioContext per content script — browsers enforce a limit on concurrent AudioContexts. Do not create per message.

5. **Rolling summary compresses in `appendConversationTurn`, not in the caller.** Callers just append turns.

6. **Tool calls from the LLM are logged and ignored in Phase 4.** Phase 5 wires `request_dom_snapshot`; Phase 6 wires `browser_action`. Do not add partial tool handling.

7. **All Phase 1–3 invariants still hold.** `background.ts` owns the WebSocket, content scripts use `chrome.runtime.sendMessage`, `sessionId` is server-assigned.
