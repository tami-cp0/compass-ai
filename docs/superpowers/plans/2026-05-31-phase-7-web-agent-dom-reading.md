# Phase 7 — Web Agent: DOM Reading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire `dispatch_automation` end-to-end for read-only tasks — Gemini calls the tool, TaskManager requests a DOM snapshot from the extension, the extension builds a viewport-weighted hybrid tree + screenshot, BAML WebAgent plans the action sequence, result is injected back into Gemini as context.

**Architecture:** TaskManager sends a `dom_snapshot_request` to the extension and awaits a promise that resolves when the extension sends `dom_snapshot` back. server.ts routes `dom_snapshot` messages to `taskManager.handleDomSnapshot()`. The extension builds a structured hybrid tree (visible viewport in full detail, off-screen condensed to interactables + headings, data grids linearized as Markdown tables) and captures a 1024×768 WebP screenshot at quality 75.

**Tech Stack:** TypeScript, Plasmo (content scripts), Chrome Extension APIs (`captureVisibleTab`, `chrome.runtime.onMessage`), BAML (`b.WebAgent`), uWebSockets.js, canvas API for image resizing.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `apps/api/src/web-agent.ts` | Create | Thin wrapper around `b.WebAgent` BAML call |
| `apps/extension/src/contents/dom-watcher.ts` | Create | DOM snapshot content script — builds hybrid tree, captures screenshot, sends `dom_snapshot` |
| `apps/api/src/task-manager.ts` | Modify | Replace `dispatchAutomation` stub; add `_runAutomation`, `handleDomSnapshot`, `pendingSnapshots` |
| `apps/api/src/server.ts` | Modify | Add `taskManager` to `apiSessions`; route `dom_snapshot` messages |

---

## Task 1: Create `web-agent.ts` — BAML WebAgent wrapper

**Files:**
- Create: `apps/api/src/web-agent.ts`

- [ ] **Step 1: Create the file**

```typescript
import { b } from "../../baml_client/index.js"
import type { WebAgentOutput } from "../../baml_client/types.js"
import { logger } from "./logger.js"

export async function runWebAgent(
  task:       string,
  elementMap: string,
  screenshot: string,
): Promise<WebAgentOutput> {
  const result = await b.WebAgent(task, elementMap, screenshot)
  logger.info("WebAgent planned", { task, actionCount: result.actions.length })
  return result
}
```

- [ ] **Step 2: Typecheck**

Run from `apps/api/`:
```bash
npx tsc --noEmit
```

Expected: no errors.

---

## Task 2: Create `dom-watcher.ts` — DOM snapshot content script

**Files:**
- Create: `apps/extension/src/contents/dom-watcher.ts`

This is a Plasmo content script. Plasmo automatically injects any `.ts` file under `src/contents/` as a content script. No manifest changes needed.

The script listens for `dom_snapshot_request` messages from `background.ts`, builds the viewport-weighted hybrid tree, captures a resized WebP screenshot, and sends a `dom_snapshot` message back.

- [ ] **Step 1: Create the file with imports, registry, and listener skeleton**

```typescript
/// <reference types="chrome" />
import type { ExtensionMessage, ServerMessage, DomTaskType } from "@compass-ai/types"

type StripSessionId<T> = T extends { sessionId: string } ? Omit<T, "sessionId"> : T
type OutboundMessage = StripSessionId<ExtensionMessage>

// Persists between snapshot and action execution (Phase 8 reads this)
export const elementRegistry = new Map<string, Map<number, Element>>()
//                                      taskId    elementId  element

chrome.runtime.onMessage.addListener((msg: ServerMessage) => {
  if (msg.type !== "dom_snapshot_request") return false
  handleSnapshotRequest(msg.taskId, msg.taskType).catch(console.error)
  return false
})
```

- [ ] **Step 2: Add the interactable element collector**

Append to the file:

```typescript
const INTERACTABLE_SELECTOR = [
  "button",
  "input",
  "select",
  "textarea",
  "a[href]",
  "[role=button]",
  "[role=link]",
  "[role=menuitem]",
  "[role=option]",
].join(", ")

function isVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect()
  const scrollY = window.scrollY
  const viewTop = scrollY
  const viewBottom = scrollY + window.innerHeight
  const elTop = rect.top + scrollY
  const elBottom = rect.bottom + scrollY
  return elBottom > viewTop && elTop < viewBottom
}

function isScrollableContainer(el: Element): boolean {
  const style = window.getComputedStyle(el)
  const overflow = style.overflow + style.overflowY + style.overflowX
  return (
    (overflow.includes("auto") || overflow.includes("scroll")) &&
    (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth)
  )
}

function collectInteractables(): Map<number, Element> {
  const registry = new Map<number, Element>()
  let id = 1

  // All standard interactables
  document.querySelectorAll<Element>(INTERACTABLE_SELECTOR).forEach((el) => {
    registry.set(id++, el)
  })

  // Scrollable containers not already captured
  document.querySelectorAll<Element>("*").forEach((el) => {
    if (isScrollableContainer(el) && !registry.has(id)) {
      registry.set(id++, el)
    }
  })

  return registry
}
```

- [ ] **Step 3: Add the grid/table linearizer**

Append to the file:

```typescript
function linearizeGrid(table: Element, registry: Map<number, Element>): string {
  const rows = Array.from(table.querySelectorAll("tr, [role=row]"))
  if (rows.length === 0) return ""

  const lines: string[] = []

  rows.forEach((row, rowIndex) => {
    const cells = Array.from(row.querySelectorAll("th, td, [role=gridcell], [role=columnheader]"))
    const cellTexts = cells.map((cell) => {
      // Find any interactable inside this cell and embed its ID
      const interactable = cell.querySelector<Element>(INTERACTABLE_SELECTOR)
      if (interactable) {
        // Find the element_id for this interactable
        for (const [eid, el] of registry) {
          if (el === interactable) {
            const tag = interactable.tagName.toLowerCase()
            const label =
              interactable.textContent?.trim() ||
              (interactable as HTMLInputElement).placeholder ||
              tag
            return `[${tag.charAt(0).toUpperCase() + tag.slice(1)}: ID ${eid}]`
          }
        }
      }
      return cell.textContent?.trim().replace(/\s+/g, " ") ?? ""
    })

    if (rowIndex === 0) {
      // Header row
      lines.push("| " + cellTexts.join(" | ") + " |")
      lines.push("|" + cellTexts.map(() => "---").join("|") + "|")
    } else {
      lines.push("| " + cellTexts.join(" | ") + " |")
    }
  })

  return lines.join("\n")
}
```

- [ ] **Step 4: Add the viewport-weighted hybrid tree builder**

Append to the file:

```typescript
function buildHybridTree(registry: Map<number, Element>): string {
  const sections: string[] = []

  // Collect all tables/grids to skip their children during normal traversal
  const gridRoots = new Set<Element>(
    Array.from(document.querySelectorAll<Element>("table, [role=grid], [role=table]"))
  )

  const visibleLines:   string[] = []
  const offscreenLines: string[] = []
  const gridSections:   string[] = []

  // Process grids first
  gridRoots.forEach((grid) => {
    const gridMd = linearizeGrid(grid, registry)
    if (gridMd) {
      const heading = grid.querySelector("caption, [role=caption]")?.textContent?.trim()
      const label = heading ? `=== ${heading.toUpperCase()} GRID ===` : "=== DATA GRID ==="
      gridSections.push(label + "\n" + gridMd)
    }
  })

  // Process interactables
  for (const [eid, el] of registry) {
    // Skip elements inside a grid (already captured above)
    if (Array.from(gridRoots).some((g) => g.contains(el))) continue

    const tag = el.tagName.toLowerCase()
    const text =
      el.textContent?.trim().replace(/\s+/g, " ") ||
      (el as HTMLInputElement).placeholder ||
      (el as HTMLElement).getAttribute("aria-label") ||
      ""
    const role = el.getAttribute("role") ?? ""
    const visible = isVisible(el)

    let label: string
    if (tag === "input") {
      const type = (el as HTMLInputElement).type || "text"
      label = `[${eid}] Input (${type}): "${(el as HTMLInputElement).value}"`
    } else if (tag === "select") {
      const selected = (el as HTMLSelectElement).options[(el as HTMLSelectElement).selectedIndex]?.text ?? ""
      label = `[${eid}] Select: "${selected}"`
    } else if (tag === "a") {
      label = `[${eid}] Link: "${text}"`
    } else if (tag === "button" || role === "button") {
      const disabled = (el as HTMLButtonElement).disabled ? " (Disabled)" : ""
      label = `[${eid}] Button: "${text}"${disabled}`
    } else if (isScrollableContainer(el)) {
      label = `[${eid}] ScrollContainer`
    } else {
      label = `[${eid}] ${tag}: "${text}"`
    }

    if (visible) {
      visibleLines.push(label)
    } else {
      offscreenLines.push(label + " [Off-screen]")
    }
  }

  // Add semantic text (headings + labels) for visible viewport
  const semanticVisible: string[] = []
  document.querySelectorAll<Element>("h1, h2, h3, label").forEach((el) => {
    if (!isVisible(el)) return
    if (Array.from(gridRoots).some((g) => g.contains(el))) return
    const tag = el.tagName.toLowerCase()
    const text = el.textContent?.trim().replace(/\s+/g, " ") ?? ""
    if (!text) return
    semanticVisible.push(`[${tag.toUpperCase()}]: "${text}"`)
  })

  // Add off-screen headings as directional anchors
  const offscreenHeadings: string[] = []
  document.querySelectorAll<Element>("h1, h2, h3").forEach((el) => {
    if (isVisible(el)) return
    const text = el.textContent?.trim().replace(/\s+/g, " ") ?? ""
    if (!text) return
    offscreenHeadings.push(`[${el.tagName}]: "${text}" [Off-screen]`)
  })

  if (semanticVisible.length > 0 || visibleLines.length > 0) {
    sections.push("=== VISIBLE VIEWPORT ===\n" + [...semanticVisible, ...visibleLines].join("\n"))
  }

  if (gridSections.length > 0) {
    sections.push(gridSections.join("\n\n"))
  }

  const belowFold = [...offscreenHeadings, ...offscreenLines]
  if (belowFold.length > 0) {
    sections.push("=== BELOW THE FOLD (OFF-SCREEN) ===\n" + belowFold.join("\n"))
  }

  return sections.join("\n\n")
}
```

- [ ] **Step 5: Add the screenshot capture with resize**

Append to the file:

```typescript
async function captureScreenshot(): Promise<string> {
  // Capture visible tab as WebP at quality 75
  const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: "webp", quality: 75 } as chrome.tabs.CaptureVisibleTabOptions & { quality: number })

  // Resize to max 1024×768 if needed
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const maxW = 1024
      const maxH = 768
      let { width, height } = img

      if (width > maxW || height > maxH) {
        const ratio = Math.min(maxW / width, maxH / height)
        width  = Math.round(width  * ratio)
        height = Math.round(height * ratio)
      }

      const canvas = document.createElement("canvas")
      canvas.width  = width
      canvas.height = height
      canvas.getContext("2d")!.drawImage(img, 0, 0, width, height)
      resolve(canvas.toDataURL("image/webp", 0.75))
    }
    img.src = dataUrl
  })
}
```

- [ ] **Step 6: Add the main handler function**

Append to the file:

```typescript
async function handleSnapshotRequest(taskId: string, _taskType: DomTaskType): Promise<void> {
  const registry = collectInteractables()
  elementRegistry.set(taskId, registry)

  const [elementMap, screenshot] = await Promise.all([
    Promise.resolve(buildHybridTree(registry)),
    captureScreenshot(),
  ])

  const msg: OutboundMessage = {
    type:        "dom_snapshot",
    taskId,
    taskType:    _taskType,
    screenshot,
    elementMap,
  }
  chrome.runtime.sendMessage(msg)
}
```

- [ ] **Step 7: Typecheck from extension root**

Run from `apps/extension/`:
```bash
npx tsc --noEmit
```

Expected: no errors. If `chrome.tabs.captureVisibleTab` types complain about the `quality` option, cast the options as `any`.

---

## Task 3: Update `task-manager.ts` — replace stub, add automation loop

**Files:**
- Modify: `apps/api/src/task-manager.ts`

- [ ] **Step 1: Add import and `pendingSnapshots` field**

At the top of the file, add the import for the message type:

```typescript
import type { ExtensionMessage } from "@compass-ai/types"
import { runWebAgent } from "./web-agent.js"
```

Inside the `TaskManager` class, add the field after `abortControllers`:

```typescript
private pendingSnapshots = new Map<string, (msg: Extract<ExtensionMessage, { type: "dom_snapshot" }>) => void>()
```

- [ ] **Step 2: Replace `dispatchAutomation`**

Replace the existing stub method:

```typescript
dispatchAutomation(name: string, description: string): Record<string, unknown> {
  if (this.session.automationSlot !== null) {
    return { status: "rejected", reason: "automation_slot_full" }
  }

  const taskId = uuidv4()
  const task: Task = {
    taskId,
    type:        "automation",
    name,
    description,
    status:      "running",
    startedAt:   Date.now(),
  }
  this.session.automationSlot = task

  const controller = new AbortController()
  this.abortControllers.set(taskId, controller)

  this._runAutomation(task)

  return { taskId, status: "dispatched" }
}
```

- [ ] **Step 3: Add `handleDomSnapshot`**

Add this public method to the class:

```typescript
handleDomSnapshot(msg: Extract<ExtensionMessage, { type: "dom_snapshot" }>): void {
  const resolve = this.pendingSnapshots.get(msg.taskId)
  if (resolve) {
    this.pendingSnapshots.delete(msg.taskId)
    resolve(msg)
  }
}
```

- [ ] **Step 4: Add `_runAutomation`**

Add this private method to the class:

```typescript
private _runAutomation(task: Task): void {
  const { taskId, name, description } = task
  const sessionId = this.session.sessionId

  // Send snapshot request to extension
  this.session.send({
    type:      "dom_snapshot_request",
    sessionId,
    taskId,
    taskType:  "structure",
  })

  // Await the snapshot with a 30-second timeout
  const snapshotPromise = new Promise<Extract<ExtensionMessage, { type: "dom_snapshot" }> | null>(
    (resolve) => {
      this.pendingSnapshots.set(taskId, resolve)

      setTimeout(() => {
        if (this.pendingSnapshots.has(taskId)) {
          this.pendingSnapshots.delete(taskId)
          resolve(null)
        }
      }, 30_000)
    }
  )

  snapshotPromise
    .then((snapshot) => {
      if (this.session.cancelledTasks.has(taskId)) {
        logger.info("Automation discarded — task was cancelled before snapshot", { taskId })
        return
      }
      if (!snapshot) {
        this.session.automationSlot = null
        this.abortControllers.delete(taskId)
        this.gemini.injectContent(`[automation context] Task "${name}" failed: no DOM snapshot received within 30s`)
        logger.error("Automation timed out waiting for dom_snapshot", { taskId, name })
        return
      }
      return runWebAgent(description, snapshot.elementMap, snapshot.screenshot)
    })
    .then((result) => {
      if (!result) return
      if (this.session.cancelledTasks.has(taskId)) {
        logger.info("Automation result discarded — task was cancelled", { taskId })
        return
      }
      this.session.automationSlot = null
      this.abortControllers.delete(taskId)
      const planSummary = result.actions.map((a) => a.description).join(" → ")
      this.gemini.injectContent(
        `[automation context] Plan for "${name}": ${result.actions.length} step(s). ${planSummary}`
      )
      logger.info("Automation plan injected", { taskId, name, actionCount: result.actions.length })
    })
    .catch((err: unknown) => {
      if (this.session.cancelledTasks.has(taskId)) {
        logger.info("Automation error discarded — task was cancelled", { taskId })
        return
      }
      this.session.automationSlot = null
      this.abortControllers.delete(taskId)
      const message = err instanceof Error ? err.message : String(err)
      this.gemini.injectContent(`[automation context] Task "${name}" failed: ${message}`)
      logger.error("Automation task failed", { taskId, name, error: message })
    })
}
```

- [ ] **Step 5: Update `cancel()` to clean up pending snapshot**

In the existing `cancel()` method, add snapshot cleanup after the `abortControllers` cleanup:

```typescript
cancel(taskId: string): Record<string, unknown> {
  this.session.cancelledTasks.add(taskId)
  this.abortControllers.get(taskId)?.abort()
  this.abortControllers.delete(taskId)

  // Clean up pending snapshot promise so _runAutomation exits cleanly
  if (this.pendingSnapshots.has(taskId)) {
    const resolve = this.pendingSnapshots.get(taskId)!
    this.pendingSnapshots.delete(taskId)
    resolve(null as unknown as Extract<ExtensionMessage, { type: "dom_snapshot" }>)
  }

  const slotIndex = this.session.researchSlots.findIndex(s => s?.taskId === taskId)
  if (slotIndex !== -1) {
    (this.session.researchSlots as Array<Task | null>)[slotIndex] = null
  }
  if (this.session.automationSlot?.taskId === taskId) {
    this.session.automationSlot = null
  }

  logger.info("Task cancelled", { taskId })
  return { status: "cancelled" }
}
```

- [ ] **Step 6: Typecheck**

Run from `apps/api/`:
```bash
npx tsc --noEmit
```

Expected: no errors.

---

## Task 4: Update `server.ts` — store `taskManager`, route `dom_snapshot`

**Files:**
- Modify: `apps/api/src/server.ts`

- [ ] **Step 1: Add `taskManager` to `ApiSession`**

Replace the existing `ApiSession` interface:

```typescript
interface ApiSession {
  sessionId:   string
  gemini:      GeminiLiveSession
  taskManager: TaskManager
}
```

- [ ] **Step 2: Store `taskManager` when setting `apiSessions`**

In the `open` handler, replace the `apiSessions.set` call:

```typescript
apiSessions.set(sessionId, { sessionId, gemini, taskManager })
```

This line currently reads `apiSessions.set(sessionId, { sessionId, gemini })` — add `taskManager` to the object.

- [ ] **Step 3: Route `dom_snapshot` in the `message` handler**

In the `message` handler, add the route after the `audio_chunk` branch:

```typescript
if (msg.type === "dom_snapshot") {
  apiSession.taskManager.handleDomSnapshot(msg)
  return
}
```

- [ ] **Step 4: Typecheck**

Run from `apps/api/`:
```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Smoke test — start the dev server**

Run from the repo root:
```bash
pnpm dev
```

Expected: server starts on port 8787 with no import or runtime errors. Check that `[automation context]` tool response logs appear when Gemini calls `dispatch_automation` (even without the extension running, the tool call handler should return `{ taskId, status: "dispatched" }` and the 30s timeout will eventually fire and log the timeout error).

---

## Self-Review

**Spec coverage:**
- ✓ `dispatch_automation` slot check and synchronous return (Task 3)
- ✓ `dom_snapshot_request` sent to extension via `session.send` (Task 3)
- ✓ 30-second timeout if no snapshot arrives (Task 3)
- ✓ `cancelledTasks` checked before snapshot processing AND before BAML result injection (Task 3)
- ✓ `runWebAgent` BAML wrapper (Task 1)
- ✓ Viewport-weighted hybrid tree with visible/off-screen sections (Task 2)
- ✓ Data grid linearization as Markdown table (Task 2)
- ✓ Off-screen interactables included and tagged `[Off-screen]` (Task 2)
- ✓ Off-screen headings as directional anchors (Task 2)
- ✓ Semantic text (h1–h3, labels) in viewport section only (Task 2)
- ✓ Screenshot: WebP, quality 75, max 1024×768, viewport only (Task 2)
- ✓ `elementRegistry` keyed by `taskId` for Phase 8 (Task 2)
- ✓ `handleDomSnapshot` public method on TaskManager (Task 3)
- ✓ `taskManager` stored in `apiSessions` (Task 4)
- ✓ `dom_snapshot` routed to `taskManager.handleDomSnapshot` in `server.ts` (Task 4)
- ✓ `cancel()` cleans up pending snapshot promise (Task 3)
- ✓ `automationSlot` cleared on completion, error, and cancel (Task 3)
- ✓ Plan injected as `[automation context]` prefix (Task 3)

**Type consistency:**
- `Extract<ExtensionMessage, { type: "dom_snapshot" }>` used consistently in `task-manager.ts` — matches the union type in `packages/types/src/messages.ts`
- `elementRegistry: Map<string, Map<number, Element>>` in `dom-watcher.ts` — keyed by `taskId`, maps to `element_id → Element` for Phase 8
- `runWebAgent(task, elementMap, screenshot)` defined in Task 1, called in Task 3 with matching signature
- `handleDomSnapshot(msg)` defined in Task 3, called in Task 4 with matching type
