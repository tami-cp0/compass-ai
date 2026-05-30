# Phase 3 Handoff — Voice Input

**Date:** 2026-05-30
**Spec:** `docs/superpowers/specs/2026-05-29-api-foundation-design.md` (full system design, §13 + §15 Phase 3)
**Stack:** pnpm workspaces + Turborepo, Plasmo (Chrome MV3), Web Speech API, µWebSockets.js, ioredis, BAML

---

## What Was Built

### `packages/types/src/speech.ts` — `SpeechProvider` interface (new file)

```ts
export interface SpeechProvider {
  start(): void
  stop(): void
  onTranscript: ((text: string, isFinal: boolean) => void) | null
}
```

Re-exported from `packages/types/src/index.ts`. `WebSpeechProvider` (Phase 3) implements this. `WhisperProvider` (future) drops in with the same interface.

---

### `apps/extension/src/speech/web-speech-provider.ts` — `WebSpeechProvider` (new file)

Wraps `window.SpeechRecognition ?? window.webkitSpeechRecognition` (cross-browser pattern).

Key behaviours:
- `continuous: true`, `interimResults: true`, `lang: "en-US"`
- `start()` guards against double-start with `if (this.recognition) return`
- `onerror` logs and lets `onend` handle cleanup
- `onend` does NOT auto-restart — pill manages the lifecycle
- `isSupported()` static method checks API availability before the pill commits to toggling state

---

### `apps/extension/src/contents/pill.tsx` — mic button wired

Module-scope singleton `const provider = new WebSpeechProvider()`.

**Toggle behaviour:**
- Click mic → `WebSpeechProvider.isSupported()` checked first (returns early + warns if unsupported, state unchanged)
- If supported: `provider.start()` + `setListening(true)`
- Click again: `provider.stop()` + `setListening(false)`

**Transcript relay:**
- `useEffect` wires `provider.onTranscript` to call `chrome.runtime.sendMessage({ type: "transcript_input", text, isFinal })`
- `background.ts` receives it in its `chrome.runtime.onMessage` listener, stamps `sessionId`, sends over WebSocket
- Cleanup: `provider.onTranscript = null` on unmount — prevents stale closures

**Icon state:**
- Listening: `MicIcon` red + `animate-pulse`
- Not listening: `MicOff` grey

---

### `apps/api/src/server.ts` — unchanged

The `message` handler already logs `{ sessionId, type: msg.type }` for every inbound message, so `transcript_input` is logged. No routing yet — that is Phase 4.

---

## Relay Architecture (invariant — do not break)

```
pill.tsx (content script)
  chrome.runtime.sendMessage({ type: "transcript_input", text, isFinal })
    ↓
background.ts
  stamps sessionId, sends JSON over WebSocket
    ↓
API gateway (server.ts)
  logs: Message received { sessionId, type: "transcript_input" }
```

Content scripts never open their own WebSocket. `background.ts` is the single owner of the connection and `sessionId`.

---

## Verified Working

```
API stdout:
{"level":"info","msg":"Message received","sessionId":"<uuid>","type":"transcript_input"}

Extension service worker console:
[compass] connected, sessionId: <uuid>
```

---

## Dev Setup

```bash
# Terminal 1
pnpm --filter @compass-ai/api dev

# Terminal 2
pnpm --filter @compass-ai/extension dev
```

After extension builds, go to `chrome://extensions` → reload Compass AI → open any page → click the mic button → speak → check API stdout for `transcript_input` log lines.

**Browser mic permission:** Chrome will prompt on first click. Must be granted.

**Plasmo HMR warnings** (`ERR_CONNECTION_REFUSED` on ports 1815/1816) — harmless dev noise, unrelated to app WebSocket.

---

## What Is NOT Done (Phase 4+)

| Item | Notes |
|------|-------|
| Voice agent invocation | Phase 4 — `VoiceAgent()` BAML function never called; `message` handler only logs |
| TTS pipeline | Phase 4 — `speech_audio` messages never sent; no audio playback in extension |
| Conversation history | Redis wired, `appendConversationTurn` exists, never called |
| Web agent (DOM capture) | Phase 5 |
| Web agent (action execution) | Phase 6 |
| Research agent | Phase 7 |
| WhisperProvider | Future — drops in behind `SpeechProvider` interface, no other changes |

---

## Key Architectural Invariants (Do Not Break)

1. **`background.ts` owns the WebSocket and `sessionId`.** Content scripts never open their own connection. They talk to `background.ts` via `chrome.runtime.sendMessage`.

2. **`sessionId` is server-assigned.** Stamped by `background.ts` on every outbound message. Never let content scripts generate or store it.

3. **`connect()` is at module scope in `background.ts`.** Not inside `onInstalled` or `onStartup` only — MV3 service workers suspend after ~30s idle and those listeners don't fire on every wake.

4. **`SpeechProvider` interface is the seam for STT swap.** Phase 3 uses `WebSpeechProvider`. Future Whisper swap = new class implementing the same interface, one-line change at the instantiation site in `pill.tsx`.

5. **All Phase 1–2 invariants still hold.** Element IDs are ephemeral, `isCritical` is the gate, rolling summary not full history, one action message per action.
