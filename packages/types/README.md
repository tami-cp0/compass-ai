# @compass-ai/types

Shared TypeScript types for the Compass AI monorepo. The single source of truth for the WebSocket wire protocol between [`@compass-ai/extension`](../../apps/extension/) and [`@compass-ai/api`](../../apps/api/), plus session and task state shapes used on both sides.

> For monorepo bootstrapping and the overall architecture diagram, see the [root README](../../README.md).

---

## Purpose

When the extension and the API need to agree on the shape of something — a WS message, a session state, a task descriptor — that shape lives here. Putting it in one package means:

- The TypeScript compiler catches mismatched fields at build time on both sides.
- Adding a new WS message is a single edit, not a synchronization exercise.
- Both consumers import the same union types and get exhaustive `switch` checking for free.

This package is **type-only at runtime**. It compiles to plain `.js` + `.d.ts`, but the `.js` files are essentially empty — all the value comes from the declarations.

---

## What's inside

```
src/
├── index.ts        # Re-exports everything
├── messages.ts     # Wire protocol: ExtensionMessage, ServerMessage, WebIntent, WebAction, ...
└── session.ts      # Session and task state shared by both ends
```

### Highlights

- **`ExtensionMessage`** — discriminated union of every message the extension sends to the API (`audio_chunk`, `dom_snapshot`, `action_result`, ...).
- **`ServerMessage`** — discriminated union of every message the API sends to the extension (`audio_chunk`, `action`, `dom_snapshot_request`, `user_action_required`, ...).
- **`WebIntent` / `WebAction`** — the action contract the web agent uses to drive the DOM (`click`, `type`, `scroll`, `highlight`).
- **`DomTaskType`** — `"click" | "form" | "read" | "structure"`. Drives how the extension prepares a DOM snapshot for the agent.

The wire types use TypeScript's discriminated unions on the `type` field, so consumers should `switch (msg.type)` and let the compiler enforce exhaustiveness.

---

## Consumption

Both consumer packages depend on this via the workspace protocol:

```jsonc
// apps/api/package.json and apps/extension/package.json
"dependencies": {
  "@compass-ai/types": "workspace:*"
}
```

Import from the package root:

```ts
import type { ExtensionMessage, ServerMessage, WebIntent } from "@compass-ai/types"
```

---

## App-Specific Commands

Run these from `packages/types/` (or with `pnpm --filter @compass-ai/types <script>` from the repo root):

| Command          | What it does                  |
| ---------------- | ----------------------------- |
| `pnpm build`     | `tsc` — emits to `dist/`      |
| `pnpm typecheck` | `tsc --noEmit`                |

Turbo's pipeline declares `^build` on every consumer, so a fresh `pnpm build` at the repo root will build this package before `@compass-ai/api` or `@compass-ai/extension`. If you change a type and consumers fail to pick it up, run `pnpm --filter @compass-ai/types build` explicitly.

---

## Workflow when changing the wire protocol

1. Edit [src/messages.ts](src/messages.ts) (or [src/session.ts](src/session.ts)) to add or change a type.
2. Run `pnpm --filter @compass-ai/types build` so the compiled `dist/` is fresh.
3. Update the producer (whichever side *sends* the new message): API in [apps/api/src/](../../apps/api/src/), extension in [apps/extension/src/](../../apps/extension/src/).
4. Update the consumer (whichever side *receives* it). The discriminated union will force you to handle the new case.
5. `pnpm typecheck` at the repo root to confirm both ends compile against the new shape.

Because this package is private and consumed only via `workspace:*`, there is no publish step — building is enough.
