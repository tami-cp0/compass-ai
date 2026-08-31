# @compass-ai/api

The Node.js back end — a single uWebSockets.js process that hosts a Gemini Live voice session per user and dispatches background research and browser-automation tasks while the assistant keeps talking. Consumed by exactly one client: the [extension](../extension/).

> Bootstrapping and architecture: [root README](../../README.md).

## What it does

Per WS connection, the API holds a persistent **Gemini Live** session (the *front desk*) and runs **research** (Gemini + Google Search grounding) and **web automation** (Anthropic Claude driving DOM actions in the extension) as background jobs (the *back office*). Tool-call results are streamed back into the live session as content parts so Gemini speaks the answer naturally.

## Layout

```
src/
├── core/       # server (WS upgrade + origin allowlist), session store, task manager, pane sizing
├── agents/     # conversation/ (Gemini Live), research/, web/ (Claude + DOM tools)
├── data/       # NGX equities dataset + lookup
└── infra/      # logger, env, session history, token tracking, provider errors, email store
```

## Key patterns

- **Concurrency limits.** `TaskManager` allows 2 research jobs and 1 automation per session; research depth scales with the query (a line for a fact, paragraphs for analysis). Over-limit requests return a structured error Gemini relays to the user.
- **Origin allowlist.** `ALLOWED_ORIGINS` is enforced on the WS upgrade in production; ignored in dev so unpacked extensions connect.
- **In-process state.** Session metadata, history, and Gemini resumption handles live in memory and don't survive a restart — the extension re-handshakes. Running multiple instances would not share state.
- **Optional email store.** User emails are recorded to Neon Postgres on session start; with no `DATABASE_URL` it's skipped and the server runs normally.
- **Logging.** pino via [src/infra/logger.ts](src/infra/logger.ts) — structured JSON in prod, pretty in dev, session-scoped child loggers, PII/secret redaction. Never `console.log`. `LOG_LEVEL` controls verbosity; `DEBUG_SESSION_IDS` forces `debug` for specific sessions.

## Commands

Run from `apps/api/` (or `pnpm --filter @compass-ai/api <script>`):

| Command | What it does |
| --- | --- |
| `pnpm dev` | `tsx watch` — hot reload, pretty logs |
| `pnpm build` | `tsc` → `dist/` |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm start` | `node dist/src/core/index.js` |

Every var in [.env.example](.env.example) is required (except `DATABASE_URL`) — the process exits `fatal` if one is missing.

## Deploying

Single long-running Node process. Build `@compass-ai/types` then this package, ship `dist/` + `package.json` (or `pnpm install --prod` on the target), provide the env vars, and run `node dist/src/core/index.js`. Front the WS port with a TLS terminator that preserves the `Origin` header so `ALLOWED_ORIGINS` works.
