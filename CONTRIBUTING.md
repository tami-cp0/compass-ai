# Contributing to Compass AI

Thanks for your interest in Compass AI. This guide covers everything needed to get the stack running locally and the conventions to follow when contributing.

Compass AI is licensed under the **MIT License** (see [LICENSE](LICENSE)). By submitting a contribution you agree to license it under the same terms.

---

## Prerequisites

Before you can run the stack you need:

| Requirement | Notes |
| ----------- | ----- |
| **Node.js 20+** | The API targets Node 20 (`@types/node@20`). |
| **pnpm 11.4.0** | Pinned via the root `packageManager` field. Install with `corepack enable && corepack prepare pnpm@11.4.0 --activate`. |
| **A running Redis** | Any Redis 6/7. Locally: `docker run -p 6379:6379 redis:7-alpine`. Stores conversation history and Gemini Live resumption handles. |
| **Google Gemini API key** | Powers the live voice session (the "front desk"). |
| **OpenAI API key + a Vector Store** | Powers stock research. You must create a Vector Store in your OpenAI account and put its id in `OPENAI_VECTOR_STORE_ID`; the repo cannot provide this for you. |
| **Anthropic (Claude) API key** | Drives the web-automation agent. |
| **Google Chrome** | To load the MV3 extension unpacked. |

> Compass AI needs its own credentials for **three** separate AI providers plus Redis. There is no bundled or free tier — being public on GitHub does not make it runnable without these.

---

## First-time setup

```bash
# 1. Install all workspace dependencies
pnpm install

# 2. Create env files for each app from the examples
cp apps/api/.env.example apps/api/.env
cp apps/extension/.env.example apps/extension/.env
```

Then fill in both `.env` files. **Every value is required** — the API and the extension each throw at startup if any variable is missing.

### `apps/api/.env`

| Variable | What it is |
| -------- | ---------- |
| `NODE_ENV` | `development` locally. In dev the WS origin allowlist is skipped. |
| `PORT` | Port the WebSocket server listens on (e.g. `8787`). |
| `LOG_LEVEL` | `trace`\|`debug`\|`info`\|`warn`\|`error`\|`fatal`. `debug` is a good local default. |
| `INSTANCE_ID` | Optional. Stable id for multi-instance deploys; falls back to hostname. |
| `DEBUG_SESSION_IDS` | Optional. Comma-separated session ids to force to `debug`. |
| `ALLOWED_ORIGINS` | Comma-separated allowed WS origins. Ignored when `NODE_ENV=development`; required otherwise. |
| `REDIS_URL` | e.g. `redis://localhost:6379`. |
| `GEMINI_API_KEY` / `GEMINI_LIVE_MODEL` | Google Gemini Live credentials + model id. |
| `OPENAI_API_KEY` | OpenAI key for the research agent. |
| `OPENAI_VECTOR_STORE_ID` | Id of a Vector Store you created in your OpenAI account. |
| `OPENAI_RESEARCH_MODEL` / `OPENAI_ALT_RESEARCH_MODEL` | Deep-research model and the fast `quick_search` model. |
| `CLAUDE_API_KEY` / `CLAUDE_WEB_MODEL` | Anthropic key + model for the web-automation agent. |

### `apps/extension/.env`

Plasmo inlines `PLASMO_PUBLIC_*` variables at build time.

| Variable | What it is |
| -------- | ---------- |
| `PLASMO_PUBLIC_WS_URL` | API WebSocket endpoint, e.g. `ws://localhost:8787/ws` in dev. |
| `PLASMO_PUBLIC_HOST_MATCH` | Host the extension activates on, e.g. `https://app.atlassportfolios.com/*`. |

---

## Running the stack

```bash
# Start Redis first (see prerequisites), then:
pnpm dev
```

`pnpm dev` runs `turbo dev`, which starts the API (hot-reloaded via `tsx watch`) and the extension (Plasmo HMR build) in parallel.

To load the extension in Chrome:

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select `apps/extension/build/chrome-mv3-dev/`.
3. Navigate to the host matched by `PLASMO_PUBLIC_HOST_MATCH` and look for the floating pill.

The extension's `chrome-extension://<id>` changes per machine/profile. In production that id must be listed in the API's `ALLOWED_ORIGINS`.

### Running a single package

```bash
pnpm --filter @compass-ai/api dev          # API only
pnpm --filter @compass-ai/extension dev     # extension only
pnpm --filter @compass-ai/types build       # rebuild shared types
```

### Common tasks

| Command | What it does |
| ------- | ------------ |
| `pnpm dev` | Run API + extension in dev (persistent, uncached). |
| `pnpm build` | Build every package; `^build` ensures `types` builds before its consumers. |
| `pnpm typecheck` | Type-check every package. Must pass before you open a PR. |

---

## Project layout

See the [root README](README.md) for the architecture overview and each package's README (`apps/api`, `apps/extension`, `packages/types`) for package-specific detail. In brief:

- **`apps/api`** — uWebSockets.js gateway, Gemini Live session, research + web agents, Redis state.
- **`apps/extension`** — Plasmo MV3 extension: pill UI, mic capture, audio playback, DOM/vision.
- **`packages/types`** — shared WebSocket wire-protocol and session/task types.

---

## Coding conventions

- **TypeScript everywhere, `strict` on.** `pnpm typecheck` must pass.
- **Wire-protocol changes go through `packages/types` first.** Edit the type, run `pnpm --filter @compass-ai/types build`, then update the sending side and the receiving side. The discriminated unions force you to handle new cases.
- **New env vars must be documented.** They are validated at startup — if you add one, add it to the relevant `.env.example` with a comment, and to the tables above.
- **Server-side logging goes through the pino wrapper** in `apps/api/src/infra/logger.ts` — never `console.log`. Use `sessionLogger(sessionId)` inside a session so lines are traceable. See the logging section of [apps/api/README.md](apps/api/README.md) for redaction rules.
- **Keep docs close to the code.** Prefer updating an existing README over adding a new doc file.

### Native dependencies

Some dependencies compile native binaries and must be listed under `allowBuilds` in `pnpm-workspace.yaml` (`@google/genai`, `esbuild`, `sharp`, `@parcel/watcher`, etc.). If you add a native dep whose install script needs to run, add it there. Note also the patched `vfile@6.0.3` in `patches/` — do not remove it without checking the extension's markdown render path.

### License headers

Per-file headers are not required — the repository-level [LICENSE](LICENSE) covers all source. If you prefer to mark a file, a one-line SPDX tag is enough:

```ts
// SPDX-License-Identifier: MIT
```

---

## Commits and pull requests

- **Commit style:** conventional commits — `feat:`, `fix:`, `chore:`, `refactor:`, `docs:`, scoped where useful (`feat(extension):`, `fix(api):`).
- **Before opening a PR:** run `pnpm typecheck` (and `pnpm build` if you touched build output) and confirm the stack still starts.
- **Keep PRs focused.** One logical change per PR is easier to review than a mixed bag.
- **Describe the why.** A short note on the problem and approach helps reviewers more than a restatement of the diff.

---

## Reporting bugs and requesting features

Open an issue on GitHub. For bugs, include: what you did, what you expected, what happened, and relevant log output (with any secrets redacted — the API redacts keys/tokens automatically, but double-check pasted snippets).

For anything security-sensitive, do **not** open a public issue — email the maintainer at findtamilore@gmail.com instead.
