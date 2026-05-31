# Phase 7 Design — Web Agent: DOM Reading

**Date:** 2026-05-31
**Scope:** Wire `dispatch_automation` end-to-end for read-only tasks. Gemini calls the tool → TaskManager requests a DOM snapshot from the extension → extension builds a viewport-weighted hybrid tree + screenshot → BAML WebAgent plans the action sequence → result injected back into Gemini as context. No action execution yet (Phase 8).

---

## 1. Data Flow

```
Gemini calls dispatch_automation(name, description)
  → GeminiLiveSession.onDispatchAutomation → TaskManager.dispatchAutomation()
      slot check: automationSlot !== null → return { status: "rejected", reason: "automation_slot_full" }
      create Task, set automationSlot, store AbortController
      return { taskId, status: "dispatched" } immediately to Gemini
      fire _runAutomation() fire-and-forget

_runAutomation():
  session.send({ type: "dom_snapshot_request", sessionId, taskId, taskType: "structure" })
  store resolver in pendingSnapshots Map<taskId, (msg) => void>
  await snapshot promise (with AbortSignal timeout)

extension dom-watcher.ts receives dom_snapshot_request:
  build viewport-weighted hybrid tree (see Section 3)
  capture viewport screenshot: WebP, 1024×768 max, quality 75
  send dom_snapshot { taskId, taskType, screenshot, elementMap } via chrome.runtime.sendMessage

server.ts routes dom_snapshot → taskManager.handleDomSnapshot(msg)
  resolves pending promise for taskId

_runAutomation() resumes:
  call b.WebAgent(description, elementMap, screenshot)
  receive WebAgentOutput { actions: WebAction[] }
  check cancelledTasks → discard silently if cancelled
  inject plan into Gemini: [automation context] ...
  clear automationSlot, delete AbortController
```

---

## 2. Screenshot

**Capture:** `chrome.tabs.captureVisibleTab(null, { format: "webp", quality: 75 })`

**Viewport only** — never a full-page screenshot. The agent sees what the user currently sees. If it needs to reach off-screen content, it issues a scroll action (informed by the off-screen section of the hybrid tree).

**Resize:** If the captured image exceeds 1024×768, scale it down preserving aspect ratio. Use an offscreen `<canvas>` to resize before base64-encoding.

**Why viewport only:** The hybrid tree already tells the agent everything off-screen. The screenshot gives spatial/visual context for the current view. Combining both gives the agent full page awareness without a massive screenshot.

---

## 3. Viewport-Weighted Hybrid Tree

The element map sent to the BAML WebAgent is a structured markdown string built by the content script. It is **not** the raw DOM — it is a purpose-built representation designed to minimise tokens while maximising agent reasoning accuracy.

### 3.1 Element ID Assignment

Every interactable element on the page (visible or not) is assigned a unique integer `element_id` starting at 1, in DOM order. The content script stores `Map<element_id, Element>` in memory for the duration of the task. This map is used in Phase 8 to execute actions by ID.

### 3.2 Interactable Elements

Captured across the **entire page** (not just viewport):
- `button`, `input`, `select`, `textarea`, `a[href]`
- `[role=button]`, `[role=link]`, `[role=menuitem]`, `[role=option]`
- Scrollable containers (`overflow: auto/scroll` with scrollHeight > clientHeight)

Visibility determined by comparing element's `getBoundingClientRect()` against `window.scrollY` and `window.innerHeight`. An element is `visible` if any part of it is within the current viewport.

### 3.3 Semantic Text (Visible Viewport Only)

In the visible viewport section, include:
- `<h1>` through `<h3>` headings
- `<label>` elements
- Direct text neighbors of interactable elements (same parent container)

Exclude: `<p>`, `<span>`, `<li>`, tooltips, generic decorative text.

Off-screen text: only `<h1>`–`<h3>` headings and direct text neighbors of off-screen interactables.

### 3.4 Data Grid / Table Linearization

When the content script encounters a `<table>` or a `div[role="grid"]` / `div[role="table"]`:
- Do **not** emit individual text nodes for each cell
- Extract headers from `<th>` or first row
- Extract each data row as a table row
- Embed interactable element IDs inline in the relevant cell: `[Button: ID 16]`
- Emit the entire grid as a single Markdown table node

This collapses dozens of fragmented text nodes into one structured block the LLM can reason about without layout ambiguity.

### 3.5 Output Format

```
=== VISIBLE VIEWPORT ===
[1] Heading: "Your Portfolio"
[2] Input (Search): ""
[3] Button: "Refresh"

=== MARKET DATA GRID ===
| Ticker | Name                    | Price  | Change | Action          |
|--------|-------------------------|--------|--------|-----------------|
| GTCO   | Guaranty Trust Holding  | 45.20  | +1.2%  | [Button: ID 16] |
| ACCESSCORP | Access Holdings PLC | 19.50  | -0.5%  | [Button: ID 21] |

=== BELOW THE FOLD (OFF-SCREEN) ===
[22] Button: "Proceed to Checkout" [Off-screen]
[23] Heading: "Recommended For You" [Off-screen]
[24] Link: "View Return Policy" [Off-screen]
```

Rules:
- Sections appear only if they contain elements (omit empty sections)
- Off-screen interactables always included, explicitly tagged `[Off-screen]`
- Off-screen headings (`<h1>`–`<h3>`) included as directional anchors
- Element IDs in the grid table are the same IDs used in Phase 8 action execution

---

## 4. New Files

### `apps/api/src/web-agent.ts`

Thin wrapper around the BAML `WebAgent` call. Same pattern as `research-agent.ts`.

```ts
import { b } from "../../baml_client/index.js"
import type { WebAgentOutput } from "../../baml_client/types.js"
import { logger } from "./logger.js"

export async function runWebAgent(
  task:        string,
  elementMap:  string,
  screenshot:  string,
): Promise<WebAgentOutput> {
  const result = await b.WebAgent(task, elementMap, screenshot)
  logger.info("WebAgent planned", { task, actionCount: result.actions.length })
  return result
}
```

No `AbortSignal` — BAML client does not expose one. Cancellation is handled via `cancelledTasks` check after the call returns.

### `apps/extension/src/contents/dom-watcher.ts`

New Plasmo content script. Runs on every page alongside `pill.tsx`.

Responsibilities:
1. Listen for `dom_snapshot_request` from `chrome.runtime.onMessage`
2. Build the viewport-weighted hybrid tree (Section 3)
3. Capture and resize the viewport screenshot (Section 2)
4. Send `dom_snapshot` via `chrome.runtime.sendMessage`

The `element_id → Element` map is stored in a module-scope `Map` keyed by `taskId`. It is populated during snapshot and will be read by the action executor in Phase 8.

```ts
// Module-scope — persists between snapshot and action execution
export const elementRegistry = new Map<string, Map<number, Element>>()
//                                      taskId    elementId  element
```

---

## 5. Modified Files

### `apps/api/src/task-manager.ts`

Replace `dispatchAutomation` stub:

```ts
private pendingSnapshots = new Map<string, (msg: DomSnapshotMessage) => void>()

dispatchAutomation(name: string, description: string): Record<string, unknown> {
  if (this.session.automationSlot !== null) {
    return { status: "rejected", reason: "automation_slot_full" }
  }
  const taskId  = uuidv4()
  const task: Task = { taskId, type: "automation", name, description, status: "running", startedAt: Date.now() }
  this.session.automationSlot = task

  const controller = new AbortController()
  this.abortControllers.set(taskId, controller)
  this._runAutomation(task, controller.signal)
  return { taskId, status: "dispatched" }
}

handleDomSnapshot(msg: DomSnapshotMessage): void {
  const resolve = this.pendingSnapshots.get(msg.taskId)
  if (resolve) {
    this.pendingSnapshots.delete(msg.taskId)
    resolve(msg)
  }
}
```

`_runAutomation` internals:
- Sends `dom_snapshot_request`, stores resolver in `pendingSnapshots`
- Awaits snapshot with a 30-second timeout (AbortSignal or `setTimeout` — if no snapshot arrives, inject error and clear slot)
- Calls `runWebAgent(description, snapshot.elementMap, snapshot.screenshot)`
- Checks `cancelledTasks` before injecting
- Injects: `[automation context] Plan for "${name}": ${result.actions.map(a => a.description).join(" → ")}`
- Clears `automationSlot`, deletes `AbortController`

`cancel()` — already implemented. Must also resolve and discard any pending snapshot promise:
```ts
// In cancel():
const resolve = this.pendingSnapshots.get(taskId)
if (resolve) {
  this.pendingSnapshots.delete(taskId)
  // Resolved with null — _runAutomation checks cancelledTasks and exits
}
```

### `apps/api/src/server.ts`

Two changes:

**1. Store `taskManager` in `apiSessions`:**
```ts
interface ApiSession {
  sessionId:   string
  gemini:      GeminiLiveSession
  taskManager: TaskManager        // ← new
}
```

**2. Route `dom_snapshot` in the `message` handler:**
```ts
if (msg.type === "dom_snapshot") {
  apiSession.taskManager.handleDomSnapshot(msg)
  return
}
```

---

## 6. Key Invariants

- `dispatchAutomation` always returns synchronously — never awaits before returning
- `pendingSnapshots` resolver is always cleaned up (on snapshot arrival, on cancel, on timeout)
- Element IDs are stable within a task's snapshot/execute cycle — the `elementRegistry` in `dom-watcher.ts` is keyed by `taskId` so Phase 8 can look up elements by the same IDs the agent planned with
- Viewport screenshot only — never full page
- BAML `WebAgent` receives the hybrid tree string and a base64 WebP screenshot
- `cancelledTasks` is checked before any result injection

---

## 7. Files Changed

| File | Change |
|---|---|
| `apps/api/src/web-agent.ts` | New — BAML WebAgent wrapper |
| `apps/extension/src/contents/dom-watcher.ts` | New — DOM snapshot content script |
| `apps/api/src/task-manager.ts` | Replace `dispatchAutomation` stub, add `handleDomSnapshot`, add `pendingSnapshots` Map |
| `apps/api/src/server.ts` | Add `taskManager` to `apiSessions`, route `dom_snapshot` messages |

---

## 8. Out of Scope (Phase 8)

- Sending `action` messages to the extension
- `action-executor.ts` content script
- `action_result` / `user_action_result` routing
- Critical action guard and `user_action_required` flow
- Multi-step planning loop (snapshot → plan → execute → re-snapshot → re-plan)
