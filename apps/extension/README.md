# @compass-ai/extension

The Chrome MV3 extension — the user-facing half of Compass AI and the only client of [`@compass-ai/api`](../api/). Plasmo + React 18 + Tailwind, runs on `<all_urls>`.

> Bootstrapping and architecture: [root README](../../README.md).

## What it does

- **Voice I/O** — captures 16 kHz PCM mic audio in an AudioWorklet, streams it over WS, plays the API's PCM replies back.
- **Vision + page data** — streams `vision_frame`s and answers `agent_observation_request` / `screenshot_request` / `page_data_request` with screenshots (plus geometry) and extracted text.
- **Action execution** — runs the web agent's `agent_action`s (click, type, scroll, ...) via the Chrome DevTools Protocol, reports back via `agent_action_result`.
- **Side panel** — onboarding, API-key entry, settings, error popups (`sidepanel.tsx`).
- **Pinned pane** — renders a markdown pane next to the pill on `pin_pane_set` / `_clear` / `_minimize`.

## Key patterns

- **The service worker owns the socket.** Content scripts never talk to the API directly; the background SW holds the single WS, so reconnects and lifecycle stay centralized. Audio and messages route through `chrome.runtime` to reach it.
- **Wire types are shared.** All WS messages use the unions in [`@compass-ai/types`](../../packages/types/) (`ExtensionMessage` out, `ServerMessage` in). New messages go through that package first.

## Environment

`PLASMO_PUBLIC_WS_URL` is inlined at build time — set it before building (localhost for dev, `wss://` for prod). See [.env.example](.env.example).

## Commands

Run from `apps/extension/` (or `pnpm --filter @compass-ai/extension <script>`):

| Command | What it does |
| --- | --- |
| `pnpm dev` | HMR build into `build/chrome-mv3-dev/` (load as unpacked) |
| `pnpm build` | Production build into `build/chrome-mv3-prod/` |
| `pnpm package` | Zips the prod build for the Chrome Web Store |

## Deploying to the Chrome Web Store

1. Build `@compass-ai/types`, then this package with `PLASMO_PUBLIC_WS_URL` pointed at the production API.
2. `pnpm package` to produce the zip.
3. Add the published `chrome-extension://<id>` to the API's `ALLOWED_ORIGINS`.
4. Host [PRIVACY.md](PRIVACY.md) and link it in the store listing.
