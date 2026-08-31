# @compass-ai/types

The single source of truth for the WebSocket wire protocol between the [extension](../../apps/extension/) and the [API](../../apps/api/), plus shared session/task state. Type-only at runtime — the compiled `.js` is essentially empty.

> Bootstrapping and architecture: [root README](../../README.md).

## What's inside

```
src/
├── messages.ts   # Wire protocol: ExtensionMessage, ServerMessage, AgentAction, ...
├── session.ts    # Session and task state
└── index.ts      # Re-exports
```

`ExtensionMessage` and `ServerMessage` are discriminated unions on the `type` field — `switch (msg.type)` and the compiler enforces exhaustiveness across both ends. `AgentAction` is the contract the web agent uses to drive the DOM.

Consumed via `"@compass-ai/types": "workspace:*"`; import from the package root.

## Commands

`pnpm build` (`tsc` → `dist/`) and `pnpm typecheck` (`tsc --noEmit`). Turbo's `^build` builds this before its consumers.

## Changing the wire protocol

Edit `messages.ts` (or `session.ts`), rebuild, then update the sender and receiver. The discriminated union forces the receiver to handle the new case; `pnpm typecheck` at the root confirms both ends compile. No publish step — building is enough.
