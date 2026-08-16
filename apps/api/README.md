# @compass-ai/api

The Node.js back end for Compass AI. A single uWebSockets.js process that hosts a Gemini Live voice session per user and dispatches background research and browser-automation tasks while the assistant keeps talking.

> For monorepo bootstrapping and the overall architecture, see the [root README](../../README.md).

---

## Purpose

This service is consumed by exactly one client: the [Compass AI browser extension](../extension/). The extension opens a single WebSocket per user session and streams 16 kHz PCM mic audio over it; the API streams Gemini's PCM audio replies back. In between, the API:

- Holds a persistent **Gemini Live** session per WS connection (the "front desk")
- Runs background **research** (Gemini with Grounding with Google Search) and **web automation** (Anthropic Claude driving DOM actions in the extension) jobs (the "back office")
- Keeps session state, in-flight tasks, conversation history, and Gemini resumption handles **in-process** (no external store)
- Streams tool-call results back into the live session as content parts so Gemini can speak the answer naturally

---

## Architecture / Tech Stack

### Source layout

```
src/
├── core/
│   ├── index.ts            # Entrypoint: load env, start server, graceful shutdown
│   ├── server.ts           # uWebSockets.js app, WS upgrade + origin allowlist, pin-pane handlers
│   ├── session-store.ts    # In-memory WS session registry
│   ├── task-manager.ts     # Concurrency limits (research x1, automation x1) + task routing
│   └── pane-estimate.ts    # Pin-pane sizing/fence helpers
├── agents/
│   ├── conversation/       # Gemini Live session + live-config (tools, system prompt)
│   ├── research/           # Gemini with Google Search grounding (single grounded-prose agent)
│   └── web/                # Web automation agent (Anthropic Claude + DOM tools, memory, steps)
├── data/
│   ├── ngx-equities.ts     # NGX equities lookup
│   └── ngx-equities-data.ts# Bundled NGX equities dataset
└── infra/
    ├── logger.ts           # pino with redaction, session-scoped child loggers
    ├── env.ts              # loads .env (side-effect import, first in entrypoint)
    ├── session-history.ts  # in-memory conversation history + Gemini resumption handles
    ├── token-tracker.ts    # Per-session token accounting
    └── datetime.ts         # Date/time helpers
```

### Key patterns

- **Concurrency limits.** `TaskManager` enforces ≤2 research jobs and ≤1 automation per session. Research runs through a single grounded-prose agent whose depth scales with the query (a line for a plain fact, paragraphs for a causal question), so a quick lookup and a deep analysis share the same two slots. New requests beyond the limit are rejected with a structured error that Gemini relays to the user.
- **Origin allowlist.** In production, `ALLOWED_ORIGINS` is enforced on the WS upgrade; in development it is ignored so unpacked extensions on any chrome-extension://... id can connect.
- **Stateless across restarts.** Session state (metadata, conversation history, resumption handles) lives in-process and does not survive an API restart by design; the extension re-handshakes and starts fresh.

---

## App-Specific Commands

Run these from `apps/api/` (or with `pnpm --filter @compass-ai/api <script>` from the repo root):

| Command              | What it does                                                       |
| -------------------- | ------------------------------------------------------------------ |
| `pnpm dev`           | `tsx watch src/core/index.ts` — hot reload, pretty pino logs       |
| `pnpm build`         | `tsc` — emits to `dist/`                                           |
| `pnpm typecheck`     | `tsc --noEmit`                                                     |
| `pnpm start`         | `node dist/src/core/index.js` — production entrypoint              |

To run *only* the API in dev (skip the extension HMR):

```powershell
pnpm --filter @compass-ai/api dev
```

See [.env.example](.env.example) for the required environment variables — every value is required and the API throws at startup if any are missing.

---

## Logging

The API logs through **pino** via a small wrapper in [src/infra/logger.ts](src/infra/logger.ts). All server-side logs go through this logger — never `console.log`.

### Shape

Every log line is structured JSON in production, pretty-printed in development. Standard fields:

```jsonc
{
  "level": "info",
  "time": "2026-06-05T12:34:56.789Z",
  "instanceId": "compass-api-01",  // INSTANCE_ID or hostname()
  "sessionId": "abc123",            // present on session-scoped child loggers
  "msg": "Gemini tool call dispatched",
  // ...arbitrary structured meta
}
```

### Levels

`trace` < `debug` < `info` < `warn` < `error` < `fatal`. Configured via `LOG_LEVEL` (default `debug` in dev, `info` in prod).

### Session-scoped logging

Almost every code path inside a WS connection should use a child logger bound to the session, obtained from `sessionLogger(sessionId)`:

```ts
import { sessionLogger } from "../infra/logger.js"

const log = sessionLogger(sessionId)
log.info("Dispatching research", { taskId, query })
```

This binds `sessionId` to every line and lets operators trace a single user's full lifecycle.

### Targeted prod debugging

Set `DEBUG_SESSION_IDS=session-a,session-b` to force `debug` level *only* for those sessions while keeping the global level at `info`. Useful for diagnosing a single user without flooding logs.

### Redaction

The logger redacts known PII / secret-bearing paths automatically with `[redacted]`:

- `*.apiKey`, `*.authorization`, `*.cookie`, `*.password`, `*.token`
- `audio`, `screenshot`, `data` (avoid logging raw media or large blobs)

If you find yourself logging something that could contain secrets or large binary payloads, add the path to the redact list in [logger.ts](src/infra/logger.ts) rather than relying on call sites to remember.

### Errors

Pass errors via `meta.error` and the wrapper will serialize `name`, `message`, `stack`, and `code` for you:

```ts
log.error("appendTurn failed", { error: err, turn: "user" })
```

---

## Deployment

The API is a single long-running Node process. To deploy:

1. `pnpm --filter @compass-ai/types build` then `pnpm --filter @compass-ai/api build` to produce `dist/`.
2. Ship `apps/api/dist/`, `apps/api/package.json`, and the workspace `node_modules` (or run `pnpm install --prod` on the target).
3. Provide every env var from [.env.example](.env.example). The process exits with a `fatal` log if any are missing.
4. Run `node dist/src/core/index.js`. Front the WS port with a TLS terminator that preserves the `Origin` header so `ALLOWED_ORIGINS` enforcement works.
5. Point the deployed extension's WS URL at the new host.

The published extension's manifest `host_permissions` must include the production host. Note that session state is in-process: a restart drops active sessions (they reconnect fresh), and running multiple API instances would not share state.
