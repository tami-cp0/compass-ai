# Phase 7 Handoff — Web Agent: DOM Reading

## What Was Built

Phase 7 wired the automation half of the Back Office for read-only tasks. When Gemini calls `dispatch_automation`, `TaskManager` requests a DOM snapshot from the extension, the extension builds a viewport-weighted hybrid tree and captures a screenshot, the BAML `WebAgent` (GPT-4o) plans the action sequence, and the plan is injected back into Gemini as context. No actions are executed yet — that is Phase 8.

---

## Architecture

```
Gemini Live (tool call: dispatch_automation)
  │  GeminiLiveSession.handleMessage()
  │  → onDispatchAutomation(name, description)  ← wired in server.ts open handler
  ▼
TaskManager.dispatchAutomation()
  │  checks session.automationSlot === null
  │  creates Task { taskId, type: "automation", name, description, status: "running" }
  │  sets session.automationSlot = task
  │  stores AbortController
  │  fires _runAutomation() as fire-and-forget
  │  returns { taskId, status: "dispatched" } immediately
  ▼
TaskManager._runAutomation()
  │  session.send({ type: "dom_snapshot_request", sessionId, taskId, taskType: "structure" })
  │  stores resolver in pendingSnapshots Map<taskId, resolver>
  │  awaits snapshot promise (30s timeout → null → injects error, clears slot)
  ▼
background.ts receives dom_snapshot_request via WebSocket
  │  chrome.tabs.sendMessage(tab.id, msg) → relays to content script
  ▼
dom-watcher.ts (content script) handleSnapshotRequest(taskId, taskType)
  │  collectInteractables() → Map<elementId, Element> + Map<Element, elementId>
  │  elementRegistry.set(taskId, registry)  ← stable IDs for Phase 8
  │  buildHybridTree(registry, inverseRegistry) → hybrid tree string
  │  captureScreenshot():
  │    chrome.runtime.sendMessage({ type: "capture_screenshot_request" })
  │    → background.ts calls chrome.tabs.captureVisibleTab(windowId, { format: "webp", quality: 75 })
  │    → resizeScreenshot() → max 1024×768 canvas resize → base64 WebP
  │  chrome.runtime.sendMessage({ type: "dom_snapshot", taskId, elementMap, screenshot })
  ▼
background.ts relays dom_snapshot to WebSocket (adds sessionId)
  ▼
server.ts message handler
  │  msg.type === "dom_snapshot" → apiSession.taskManager.handleDomSnapshot(msg)
  ▼
TaskManager.handleDomSnapshot()
  │  resolves pendingSnapshots promise for taskId
  ▼
TaskManager._runAutomation() resumes
  │  checks cancelledTasks → discard if cancelled
  │  runWebAgent(description, snapshot.elementMap, snapshot.screenshot)
  │    → b.WebAgent(task, elementMap, screenshot) → WebAgentOutput { actions: WebAction[] }
  │  checks cancelledTasks → discard if cancelled
  │  gemini.injectContent(`[automation context] Plan for "${name}": N step(s). step1 → step2 ...`)
  │  session.automationSlot = null, abortControllers.delete(taskId)
  ▼
GeminiLiveSession.injectContent()
  └  sendClientContent({ turns: [{ role: "user", parts: [{ text }] }], turnComplete: false })
     → Gemini has context about what the automation agent planned
```

---

## Key Files

### `apps/api/src/web-agent.ts` — New

Thin wrapper around `b.WebAgent`. Receives the hybrid tree string and base64 WebP screenshot, returns `WebAgentOutput { actions: WebAction[] }`.

No `AbortSignal` — the BAML client does not expose one. Cancellation is handled via the `cancelledTasks` check after the call returns.

---

### `apps/extension/src/contents/dom-watcher.ts` — New

Plasmo content script auto-registered by placement under `src/contents/`. Runs alongside `pill.tsx` on every page.

**`elementRegistry`** (module-scope):
```ts
export const elementRegistry = new Map<string, Map<number, Element>>()
//                                      taskId    elementId  element
```
Persists between snapshot (Phase 7) and action execution (Phase 8). Phase 8's action executor reads this map to resolve element IDs back to live DOM nodes.

**`collectInteractables()`** — queries the full page (not just viewport):
- Selectors: `button, input, select, textarea, a[href], [role=button/link/menuitem/option]`
- Also captures scrollable containers (`overflow: auto/scroll` with `scrollHeight > clientHeight`)
- Assigns sequential integer IDs starting at 1 in DOM order
- Returns both `registry: Map<number, Element>` and `inverseRegistry: Map<Element, number>` for O(1) grid cell lookups

**`buildHybridTree(registry, inverseRegistry)`** — produces three sections (omitted if empty):

```
=== VISIBLE VIEWPORT ===
[H1]: "Your Portfolio"
[LABEL]: "Search"
[1] Input (search): ""
[2] Button: "Refresh"

=== DATA GRID ===
| Ticker | Name | Price | Action |
|---|---|---|---|
| GTCO | Guaranty Trust | 45.20 | [Button: ID 16] |

=== BELOW THE FOLD (OFF-SCREEN) ===
[22] Button: "Proceed to Checkout" [Off-screen]
[H2]: "Recommended For You" [Off-screen]
```

- Visible viewport: h1–h3/label semantic text + visible interactables
- Data grids: `<table>` and `[role=grid/table]` linearized as Markdown tables with embedded `[Tag: ID N]` for interactables in cells; uses `Element.closest` to exclude grid children from normal traversal (O(log N) per element)
- Off-screen: interactables tagged `[Off-screen]`, h1–h3 headings as directional anchors

**`captureScreenshot()`** — cannot call `chrome.tabs.captureVisibleTab` directly (content script restriction). Sends `{ type: "capture_screenshot_request" }` to background, which captures using the `sender.tab.windowId` to target the correct window in multi-window setups. Resizes via offscreen canvas to max 1024×768 preserving aspect ratio.

---

### `apps/extension/src/background.ts` — Modified

Two additions:

**Screenshot capture listener** (before the relay listener):
```ts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "capture_screenshot_request") return false
  const windowId = sender.tab?.windowId
  chrome.tabs.captureVisibleTab(windowId, { format: "webp", quality: 75 }, (dataUrl) => {
    sendResponse({ dataUrl })
  })
  return true // keep channel open for async response
})
```

**Relay listener guard** — prevents `capture_screenshot_request` from being forwarded to the WebSocket:
```ts
chrome.runtime.onMessage.addListener((message: OutboundExtensionMessage | { type: "capture_screenshot_request" }) => {
  if (message.type === "capture_screenshot_request") return false
  // ... existing relay logic
})
```

---

### `apps/api/src/task-manager.ts` — Modified

New field:
```ts
private pendingSnapshots = new Map<string, (msg: DomSnapshot | null) => void>()
```

**`dispatchAutomation(name, description)`** — replaces the Phase 6 stub. Synchronous return, slot check, task creation, fire-and-forget `_runAutomation`.

**`handleDomSnapshot(msg)`** — public method called by `server.ts`. Resolves the pending promise for `msg.taskId`.

**`_runAutomation(task)`** — promise chain:
1. Send `dom_snapshot_request`
2. Await snapshot (30s timeout resolves with `null`)
3. On cancel: clear `automationSlot` + `abortControllers`, return
4. On timeout: clear slot, inject error
5. On valid snapshot: call `runWebAgent`, then inject plan summary
6. On error: clear `pendingSnapshots`, clear slot, inject error

**`cancel(taskId)`** — updated to also unblock any pending snapshot promise by resolving it with `null`. `_runAutomation`'s cancelled branch owns `automationSlot` cleanup — `cancel()` does not clear the slot directly, to prevent a race where a second `dispatchAutomation` call fills the slot before the first task's promise chain finishes.

---

### `apps/api/src/server.ts` — Modified

```ts
interface ApiSession {
  sessionId:   string
  gemini:      GeminiLiveSession
  taskManager: TaskManager       // ← added
}
```

`taskManager` is stored in `apiSessions` on `open`. The `message` handler routes `dom_snapshot` to `apiSession.taskManager.handleDomSnapshot(msg)`.

---

## Key Invariants

- `dispatchAutomation` always returns synchronously — never awaits before returning
- `pendingSnapshots` resolver is always cleaned up in all paths: snapshot arrival (`handleDomSnapshot`), timeout (`setTimeout`), cancel (`cancel()`), error (`.catch`)
- `automationSlot` is owned exclusively by `_runAutomation` — only the promise chain clears it (not `cancel()`), preventing the race where `cancel()` clears the slot while a second task has already filled it
- `cancelledTasks` is checked before snapshot processing AND before BAML result injection — a BAML call that completes after cancel is silently discarded
- `elementRegistry` in `dom-watcher.ts` is keyed by `taskId` — Phase 8 looks up element IDs using the same map the snapshot created, guaranteeing ID stability between planning and execution
- Screenshot is viewport-only, never full-page — the hybrid tree covers off-screen content structurally

---

## What Phase 8 Must Do

Phase 8 wires action execution. The WebAgent's `WebAction[]` plan is already in Gemini's context after Phase 7. Phase 8 gives the agent a way to actually execute those actions.

### TaskManager additions:

1. **Send `action` messages** to the extension for each step in the plan
2. **Route `action_result`** messages from `server.ts` back into the execution loop
3. **Handle `isCritical` actions** — send `user_action_required` to the extension, await `user_action_result` before proceeding
4. **Multi-step loop** — after each action, optionally re-snapshot to verify state before the next step
5. **Send `automation_end`** to the extension on completion, cancellation, or error

### Extension additions:

1. **`action-executor.ts`** content script — listens for `action` messages, reads `elementRegistry.get(taskId)` to resolve element IDs, executes the `WebIntent` (`click`, `type`, `scroll`, `highlight`)
2. **`user_action_required` UI** — show a confirmation prompt in the pill or overlay, send `user_action_result` on user response

### Message types already defined (no changes to `packages/types/src/messages.ts` needed):

```ts
// API → Extension (already in ServerMessage union)
{ type: "action";              sessionId; actionId; taskId; intent: WebIntent; isCritical }
{ type: "user_action_required"; sessionId; actionId; taskId; description }
{ type: "automation_end";      sessionId; taskId; reason: "complete"|"cancelled"|"error"; error? }

// Extension → API (already in ExtensionMessage union)
{ type: "action_result";      sessionId; actionId; taskId; success; error? }
{ type: "user_action_result"; sessionId; actionId; taskId; confirmed }
```

`server.ts` must route `action_result` and `user_action_result` to `taskManager` — same pattern as `dom_snapshot`.

---

## Commit

```
e3c3631 feat(phase-7): wire dispatch_automation end-to-end for DOM reading
```
