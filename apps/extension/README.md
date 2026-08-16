# @compass-ai/extension

The Chrome MV3 browser extension that is the user-facing half of Compass AI. Renders the floating "pill" UI on the configured stockbroking site, captures the user's microphone, plays the assistant's voice back, and executes the DOM actions the API requests.

> For monorepo bootstrapping and the overall architecture, see the [root README](../../README.md).

---

## Purpose

This is the only client of [`@compass-ai/api`](../api/). It runs on all sites (`<all_urls>`) and does three things:

1. **Voice I/O.** Captures 16 kHz PCM mic audio in an AudioWorklet and streams it over WebSocket; receives PCM from the API and plays it through the Web Audio API.
2. **Vision + page data.** Streams `vision_frame`s for the live session, and replies to `agent_observation_request` / `screenshot_request` / `page_data_request` with a screenshot (plus geometry) and extracted text so the agents can reason about the live UI.
3. **Action execution.** Performs `agent_action`s (`click`, `type`, `scroll`, `highlight`, ...) on behalf of the web agent and reports back via `agent_action_result`.
4. **Pinned pane.** Renders a markdown pane next to the pill in response to `pin_pane_set` / `pin_pane_clear` / `pin_pane_minimize`.

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
├── contents/                 # Plasmo content scripts (run on all sites)
│   ├── pill.tsx              # Floating React pill UI (mic, state, bars, edge glow)
│   ├── pin-panel.tsx         # Pinned markdown pane rendered next to the pill
│   ├── components/           # Pill subcomponents (icon, frequency bars, chips, ...)
│   ├── hooks/                # React hooks (use-session, ...)
│   └── lib/                  # Local utilities (audio-runtime, edge-glow, pill-view)
├── vendor/
│   └── react-markdown.js     # Bundled react-markdown (see vendor:markdown script)
└── styles/
    ├── globals.css           # Tailwind entry
    └── pin-panel.css         # Pin-pane styles
```

### Key patterns

- **Service worker owns the socket.** Content scripts never talk to the API directly. The background SW holds the single WS, so reconnects and lifecycle are centralized.
- **Wire types are shared.** All messages over the WS use the union types in [`@compass-ai/types`](../../packages/types/) (`ExtensionMessage` for extension → API, `ServerMessage` for API → extension). Adding a new message means editing that package first.
- **Audio flows through the service worker.** Frames go through `chrome.runtime` between the content script and the SW so the single WS stays centralized.

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
4. Navigate to any page and look for the pill

The extension's chrome-extension://... ID changes per machine/profile. In production, that ID goes into the API's `ALLOWED_ORIGINS`.

---

## Deployment

1. `pnpm --filter @compass-ai/types build` then `pnpm --filter @compass-ai/extension build`.
2. `pnpm --filter @compass-ai/extension package` to produce a zip ready for the Chrome Web Store.
3. Update the API's `ALLOWED_ORIGINS` to include the published extension's `chrome-extension://<id>`.
4. Ensure `PLASMO_PUBLIC_WS_URL` points at the production API host before building.
