# Compass AI

A voice copilot for [Atlass Portfolios](https://app.atlassportfolios.com). The user speaks to an AI assistant that can automate the page on their behalf and research stocks in real time, without the assistant ever going silent.

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

# 3. Start Redis locally (or point REDIS_URL at a remote one)
#   e.g. docker run -p 6379:6379 redis:7-alpine

# 4. Run the whole stack in dev mode (API + extension HMR)
pnpm dev
```

Then load the extension build at `apps/extension/build/chrome-mv3-dev/` as an unpacked extension in Chrome and navigate to `https://app.atlassportfolios.com`.

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

## Contribution Guidelines

- **TypeScript** everywhere; `strict` is on. `pnpm typecheck` must pass.
- **No new READMEs or doc files** without a real reason — keep documentation close to the code it describes.
- **Env vars** are validated at startup; if you add one, update the relevant `.env.example` with a comment explaining what it is.
- **Wire protocol changes** go through `packages/types` first so both ends stay in sync; rebuild `@compass-ai/types` before relying on the new shape.
- **Commits** follow conventional-commit style (`feat:`, `fix:`, `chore:`, `refactor:`, etc), scoped where useful (`feat(extension):`).
- **Logging** uses the structured pino logger in the API ([apps/api/README.md](apps/api/README.md#logging) has the full overview). Never `console.log` server-side.

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
