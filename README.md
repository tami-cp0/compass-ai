# Compass AI

A voice copilot for the stock market. The user speaks to an AI assistant that can automate the page on their behalf and research stocks in real time, without the assistant ever going silent.

> **License:** MIT. Contributions are accepted under the same license — see [LICENSE](LICENSE) and [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Repository Architecture

This is a **pnpm + Turborepo monorepo** containing the full Compass AI stack: a browser extension front end, a Node.js WebSocket API back end, and a shared TypeScript types package.

The **Front Desk / Back Office** pattern is the load-bearing idea. Gemini Live owns a persistent audio session and keeps talking to the user. Heavy work (web automation, stock research) is dispatched to background workers via tool calls that return immediately. Results are injected back into the live session as content parts when the workers finish.

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
