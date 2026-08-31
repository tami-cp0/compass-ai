<h1 align="center">Compass AI</h1>

<p align="center">
  <strong>A voice copilot for the stock market.</strong><br />
  Talk to it. It watches your screen, researches stocks in real time, and drives the page for you — without ever going silent.
</p>

<p align="center">
  <img src="image.png" alt="Compass AI running live on a stock chart, with the voice pill in the page and the side panel open" width="100%" />
</p>

<p align="center">
  <em>The floating pill sits on any brokerage or charting site; the side panel holds your keys and controls. You speak, Compass answers in a real voice — and can act on the page while it talks.</em>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-1f9d76.svg" /></a>
  <img alt="Chrome MV3" src="https://img.shields.io/badge/Chrome-MV3-1f9d76.svg" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-1f9d76.svg" />
  <img alt="Monorepo" src="https://img.shields.io/badge/pnpm-Turborepo-1f9d76.svg" />
</p>

---

## What it does

- 🎙️ **Real-time voice.** A persistent Gemini Live session streams your 16 kHz mic audio up and speaks answers back — a genuine conversation, not press-to-talk.
- 👁️ **It sees your screen.** A live vision stream lets the assistant reason about the chart or holdings you're actually looking at.
- 🔎 **Researches while it talks.** Background research (Gemini + Google Search grounding) runs as fire-and-forget tool calls; results are spoken back the moment they land.
- 🖱️ **Acts on the page.** An Anthropic Claude web agent drives real DOM actions — click, type, scroll, navigate — via the Chrome DevTools Protocol, so it can complete tasks for you.
- 🔑 **Your keys, your browser.** Users bring their own API keys; they live in local storage and are used only to make their own provider calls.

---

## The core idea: Front Desk / Back Office

The load-bearing design decision. **Gemini Live is the front desk** — it owns a persistent audio session and never stops talking to the user. **Heavy work is the back office** — web automation and stock research are dispatched to background workers via tool calls that *return immediately*. When a worker finishes, its result is injected back into the live session as a content part, so the assistant can speak the answer naturally without the awkward silence that kills voice UX.

This is what lets Compass stay conversational while doing genuinely slow work (a multi-step page automation, a grounded research pass) underneath.

---

## Repository Architecture

This is a **pnpm + Turborepo monorepo** containing the full Compass AI stack: a browser extension front end, a Node.js WebSocket API back end, and a shared TypeScript types package.

### Packages

| Path                              | Name                    | Purpose                                                                                  |
| --------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------- |
| [apps/api](apps/api/)             | `@compass-ai/api`       | uWebSockets.js gateway, Gemini Live voice session, TaskManager, research + web agents    |
| [apps/extension](apps/extension/) | `@compass-ai/extension` | Plasmo browser extension: pill UI, mic capture, audio playback, DOM watcher              |
| [packages/types](packages/types/) | `@compass-ai/types`     | Shared TypeScript types for the WS wire protocol and session/task state                  |

---

## Bootstrapping

```powershell
# 1. Install all workspace dependencies
pnpm install

# 2. Copy and fill in env for each app
cp apps/api/.env.example apps/api/.env
cp apps/extension/.env.example apps/extension/.env
#   then edit both — every value is required and the app throws at startup if missing

# 3. Run the whole stack in dev mode (API + extension HMR)
pnpm dev
```

Then load the extension build at `apps/extension/build/chrome-mv3-dev/` as an unpacked extension in Chrome and navigate to any page — the pill activates on all sites.

---

## Monorepo Tooling

The workspace is managed by **[Turborepo](https://turbo.build/)** on top of pnpm workspaces. The task pipeline lives in [turbo.json](turbo.json):

| Command           | What it does                                                                  |
| ----------------- | ----------------------------------------------------------------------------- |
| `pnpm dev`        | Runs `dev` in every package in parallel (persistent, no cache)                |
| `pnpm build`      | Builds every package; honours `^build` so `types` builds before its consumers |
| `pnpm typecheck`  | Type-checks every package; depends on upstream `build` for declaration files  |

To run a task in just one package, use pnpm's filter:

```powershell
pnpm --filter @compass-ai/api dev
pnpm --filter @compass-ai/extension build
pnpm --filter @compass-ai/types build
```

`pnpm-workspace.yaml` lists which native dependencies are allowed to run install scripts (`@google/genai`, `esbuild`, `lmdb`, etc). Add to `allowBuilds` when a new native dep needs to be compiled.

---

## Contributing

Setup, dev workflow, coding conventions, and the wire-protocol change process live in [CONTRIBUTING.md](CONTRIBUTING.md). In short: TypeScript everywhere with `strict` on, `pnpm typecheck` must pass, wire-protocol changes go through `packages/types` first, and commits follow conventional-commit style.

---

## Directory Structure

```
compass-ai/
├── apps/
│   ├── api/                    # WebSocket API + Gemini Live + agents
│   └── extension/              # Plasmo Chrome extension (MV3)
├── packages/
│   └── types/                  # Shared WS messages + session/task types
├── package.json                # Root scripts + turbo
├── pnpm-workspace.yaml         # Workspace globs + allowBuilds
└── turbo.json                  # Task pipeline
```

---

## License

Compass AI is licensed under the **MIT License**. See [LICENSE](LICENSE) for the full text.

MIT is a permissive license: you may use, copy, modify, and distribute the software — including in closed-source and commercial products — provided you keep the copyright notice and license text. The software is provided "as is", without warranty.

**Disclaimer:** Compass AI is an independent, unaffiliated project. It is **not** affiliated with, associated with, authorized by, endorsed by, or in any way officially connected to any third-party stockbroking platform or its owners. Any platform names or marks referenced in configuration are the property of their respective owners and are used here only to describe the third-party websites this tool can interoperate with.
