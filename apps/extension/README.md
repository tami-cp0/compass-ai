# @compass-ai/extension

The Chrome MV3 browser extension that is the user-facing half of Compass AI. Renders the floating "pill" UI on [Atlass Portfolios](https://app.atlassportfolios.com), captures the user's microphone, plays the assistant's voice back, and executes the DOM actions the API requests.

> For monorepo bootstrapping and the overall architecture, see the [root README](../../README.md).

---

## Purpose

This is the only client of [`@compass-ai/api`](../api/). It is scoped exclusively to the host defined by `PLASMO_PUBLIC_HOST_MATCH` and does three things:

1. **Voice I/O.** Captures 16 kHz PCM mic audio in an AudioWorklet and streams it over WebSocket; receives PCM from the API and plays it through the Web Audio API.
2. **DOM access.** Watches the page for tagged elements and replies to `dom_snapshot_request` from the API with a screenshot + element map so the web agent can reason about the live UI.
3. **Action execution.** Performs `click`, `type`, `scroll`, and `highlight` intents on behalf of the agent and reports back success/failure.

---

## Architecture / Tech Stack

Built with **[Plasmo](https://www.plasmo.com/)** (MV3) + React 18 + Tailwind. TypeScript everywhere.

```
src/
├── background.ts             # MV3 service worker: WS client + message router
├── declarations.d.ts         # Module declarations (CSS, assets)
├── audio/
│   ├── pcm-capture.ts        # MediaStream → AudioWorklet wiring
│   ├── pcm-capture-worklet.js# AudioWorklet: downsample + post int16 frames
│   └── pcm-player.ts         # Web Audio queue + scheduling for inbound PCM
├── contents/                 # Plasmo content scripts (run on the matched host)
│   ├── pill.tsx              # Floating React pill UI (mic, state, bars, edge glow)
│   ├── dom-watcher.ts        # Element tagging, screenshot, action executor
│   ├── components/           # Pill subcomponents
│   ├── hooks/                # React hooks (session state, audio level, etc.)
│   └── lib/                  # Local utilities
└── styles/
    └── globals.css           # Tailwind entry
```

### Key patterns

- **Service worker owns the socket.** Content scripts never talk to the API directly. The background SW holds the single WS, so reconnects and lifecycle are centralized.
- **Wire types are shared.** All messages over the WS use the union types in [`@compass-ai/types`](../../packages/types/) (`ExtensionMessage`, `ServerMessage`). Adding a new message means editing that package first.
- **Audio is never base64'd between content and SW.** Frames go through `chrome.runtime` as transferable-friendly payloads to minimize copies.
- **Critical actions require user confirmation.** When the API sends `user_action_required`, the pill prompts the user and replies with `user_action_result`.

---

## Environment Variables

Plasmo inlines variables prefixed with `PLASMO_PUBLIC_` at build time. See [.env.example](.env.example) for the canonical list — every value is required and the extension throws at startup if missing.

---

## App-Specific Commands

Run from `apps/extension/` (or with `pnpm --filter @compass-ai/extension <script>` from the repo root):

| Command          | What it does                                                                         |
| ---------------- | ------------------------------------------------------------------------------------ |
| `pnpm dev`       | `plasmo dev` — HMR build into `build/chrome-mv3-dev/`. Load that as an unpacked ext. |
| `pnpm build`     | `plasmo build` — production build into `build/chrome-mv3-prod/`.                     |
| `pnpm package`   | `plasmo package` — zips the prod build for the Chrome Web Store.                     |

### Loading the dev build in Chrome

1. `pnpm --filter @compass-ai/extension dev`
2. Open `chrome://extensions`, enable Developer mode
3. Click "Load unpacked", point at `apps/extension/build/chrome-mv3-dev/`
4. Navigate to the matched host and look for the pill

The extension's chrome-extension://... ID changes per machine/profile. In production, that ID goes into the API's `ALLOWED_ORIGINS`.

---

## Deployment

1. `pnpm --filter @compass-ai/types build` then `pnpm --filter @compass-ai/extension build`.
2. `pnpm --filter @compass-ai/extension package` to produce a zip ready for the Chrome Web Store.
3. Update the API's `ALLOWED_ORIGINS` to include the published extension's `chrome-extension://<id>`.
4. Ensure `PLASMO_PUBLIC_WS_URL` points at the production API host before building.
