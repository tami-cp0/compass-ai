/// <reference types="chrome" />
import type { ExtensionMessage, ServerMessage, DomTaskType, WebIntent } from "@compass-ai/types"
import type { PlasmoCSConfig } from "plasmo"

export const config: PlasmoCSConfig = {
  matches: ["<all_urls>"]
}

type StripSessionId<T> = T extends { sessionId: string } ? Omit<T, "sessionId"> : T
type OutboundMessage = StripSessionId<ExtensionMessage>

// Persists between snapshot (dom_snapshot_request) and action execution (action)
export const elementRegistry = new Map<string, Map<number, Element>>()
//                                      taskId    elementId  element

// Single persistent port to background — keeps the MV3 service worker alive across
// all async operations so captureVisibleTab and WebSocket sends always complete.
let relayPort: chrome.runtime.Port

let screenshotResolve: ((dataUrl: string) => void) | null = null

function connectRelayPort(): void {
  relayPort = chrome.runtime.connect({ name: "compass-relay" })
  relayPort.onMessage.addListener((msg: { type: string; dataUrl?: string }) => {
    if (msg.type === "capture_screenshot_response" && screenshotResolve) {
      const resolve = screenshotResolve
      screenshotResolve = null
      resolve(msg.dataUrl ?? "")
    }
  })
  relayPort.onDisconnect.addListener(() => {
    // Service worker was killed; reconnect so next operation works
    connectRelayPort()
  })
}

connectRelayPort()

function relayToBackground(message: OutboundMessage): void {
  relayPort.postMessage(message)
}

chrome.runtime.onMessage.addListener((msg: ServerMessage) => {
  if (msg.type === "dom_snapshot_request") {
    handleSnapshotRequest(msg.taskId, msg.taskType).catch(console.error)
    return false
  }
  if (msg.type === "action") {
    handleAction(msg.taskId, msg.actionId, msg.intent)
      .then((result) => {
        relayToBackground({
          type:     "action_result",
          actionId: msg.actionId,
          taskId:   msg.taskId,
          success:  result.success,
          ...(result.error ? { error: result.error } : {}),
        })
      })
      .catch((err: unknown) => {
        relayToBackground({
          type:     "action_result",
          actionId: msg.actionId,
          taskId:   msg.taskId,
          success:  false,
          error:    err instanceof Error ? err.message : String(err),
        })
      })
    return false
  }
  if (msg.type === "screenshot_request") {
    captureScreenshot()
      .then((dataUrl) => {
        relayToBackground({ type: "screenshot_response", requestId: msg.requestId, dataUrl })
      })
      .catch((err: unknown) => {
        console.error("[compass] captureScreenshot failed for screenshot_request:", err)
        relayToBackground({ type: "screenshot_response", requestId: msg.requestId, dataUrl: "" })
      })
    return false
  }
  return false
})

// ─── Action execution ────────────────────────────────────────────────────────

async function handleAction(
  taskId:    string,
  _actionId: string,
  intent:    WebIntent,
): Promise<{ success: boolean; error?: string }> {
  const registry = elementRegistry.get(taskId)
  if (!registry) {
    return { success: false, error: `No element registry for taskId ${taskId}` }
  }

  try {
    await executeIntent(intent, registry)
    return { success: true }
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function syntheticClick(el: HTMLElement): void {
  const rect = el.getBoundingClientRect()
  const cx = rect.left + rect.width / 2
  const cy = rect.top + rect.height / 2
  const opts: MouseEventInit = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, view: window }
  el.dispatchEvent(new MouseEvent("mousedown", opts))
  el.dispatchEvent(new MouseEvent("mouseup", opts))
  el.dispatchEvent(new MouseEvent("click", opts))
}

async function executeIntent(intent: WebIntent, registry: Map<number, Element>): Promise<void> {
  if (intent.action === "click") {
    const el = registry.get(intent.element_id)
    if (!el) throw new Error(`Element ID ${intent.element_id} not found`)
    console.log(`[compass] click element_id=${intent.element_id} tag=${el.tagName} text="${(el as HTMLElement).innerText?.slice(0, 80)}" outerHTML="${el.outerHTML.slice(0, 200)}"`)
    syntheticClick(el as HTMLElement)
    return
  }

  if (intent.action === "type") {
    const el = registry.get(intent.element_id)
    if (!el) throw new Error(`Element ID ${intent.element_id} not found`)
    if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) {
      throw new Error(`Element ID ${intent.element_id} is not a typeable input (got ${el.tagName})`)
    }
    const input = el
    input.focus()
    input.value = intent.value
    input.dispatchEvent(new Event("input", { bubbles: true }))
    input.dispatchEvent(new Event("change", { bubbles: true }))
    return
  }

  if (intent.action === "scroll") {
    if (intent.element_id === null) {
      window.scrollBy({
        top:      intent.direction === "down" ? intent.amount : -intent.amount,
        behavior: "smooth",
      })
      return
    }
    const el = registry.get(intent.element_id)
    if (!el) throw new Error(`Element ID ${intent.element_id} not found`)
    el.scrollBy({
      top:      intent.direction === "down" ? intent.amount : -intent.amount,
      behavior: "smooth",
    })
    return
  }

  if (intent.action === "highlight") {
    const el = registry.get(intent.element_id)
    if (!el) throw new Error(`Element ID ${intent.element_id} not found`)
    const text = el.textContent ?? ""
    const idx  = text.indexOf(intent.text_snippet)
    if (idx === -1) throw new Error(`text_snippet "${intent.text_snippet}" not found in element`)

    const range = document.createRange()
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let offset = 0
    let startNode: Text | null = null
    let startOffset = 0
    let endNode: Text | null = null
    let endOffset = 0

    while (walker.nextNode()) {
      const node = walker.currentNode as Text
      const nodeLen = node.length
      if (startNode === null && offset + nodeLen > idx) {
        startNode = node
        startOffset = idx - offset
      }
      if (startNode !== null && endNode === null && offset + nodeLen >= idx + intent.text_snippet.length) {
        endNode = node
        endOffset = idx + intent.text_snippet.length - offset
        break
      }
      offset += nodeLen
    }

    if (!startNode || !endNode) throw new Error("Could not locate text_snippet in DOM text nodes")
    range.setStart(startNode, startOffset)
    range.setEnd(endNode, endOffset)

    const sel = window.getSelection()
    if (sel) {
      sel.removeAllRanges()
      sel.addRange(range)
    }
    return
  }

  throw new Error(`Unknown action: ${(intent as { action: string }).action}`)
}

// ─── DOM snapshot ─────────────────────────────────────────────────────────────

const SEMANTIC_SELECTOR = [
  "button",
  "input",
  "select",
  "textarea",
  "a[href]",
  "[role=button]",
  "[role=link]",
  "[role=menuitem]",
  "[role=option]",
  "[role=treeitem]",
  "[role=tab]",
  "[role=checkbox]",
  "[role=radio]",
  "[role=switch]",
].join(", ")

function isVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect()
  return rect.bottom > 0 && rect.top < window.innerHeight
}

function isScrollableContainer(el: Element): boolean {
  const style = window.getComputedStyle(el)
  const overflow = style.overflow + style.overflowY + style.overflowX
  return (
    (overflow.includes("auto") || overflow.includes("scroll")) &&
    (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth)
  )
}

// Returns true for elements that behave like clickable controls even without
// semantic HTML — e.g. Dojo/Ext.js divs with onclick, or cursor:pointer leaves.
function isClickableNonSemantic(el: Element): boolean {
  // Must have some visible text to be useful to the agent
  const text = (el as HTMLElement).innerText?.trim()
  if (!text || text.length === 0) return false

  // Has an explicit onclick attribute
  if (el.hasAttribute("onclick")) return true

  // Computed cursor is pointer AND it's a leaf node (no interactive children)
  // — avoids capturing giant wrapper divs that happen to have pointer cursor
  const style = window.getComputedStyle(el as HTMLElement)
  if (style.cursor === "pointer") {
    const hasInteractiveChild = el.querySelector(SEMANTIC_SELECTOR) !== null
    if (!hasInteractiveChild) return true
  }

  return false
}

function collectInteractables(): { registry: Map<number, Element>; inverseRegistry: Map<Element, number> } {
  const registry = new Map<number, Element>()
  const inverseRegistry = new Map<Element, number>()
  const seen = new Set<Element>()
  let id = 1

  // Pass 1: semantic elements
  document.querySelectorAll<Element>(SEMANTIC_SELECTOR).forEach((el) => {
    seen.add(el)
    registry.set(id, el)
    inverseRegistry.set(el, id)
    id++
  })

  // Pass 2: non-semantic clickables (onclick attrs, cursor:pointer leaves)
  document.querySelectorAll<Element>("*").forEach((el) => {
    if (seen.has(el)) return
    if (isClickableNonSemantic(el)) {
      seen.add(el)
      registry.set(id, el)
      inverseRegistry.set(el, id)
      id++
      return
    }
    if (isScrollableContainer(el)) {
      seen.add(el)
      registry.set(id, el)
      inverseRegistry.set(el, id)
      id++
    }
  })

  return { registry, inverseRegistry }
}

function linearizeGrid(table: Element, inverseRegistry: Map<Element, number>): string {
  const allRows = Array.from(table.querySelectorAll("tr, [role=row]"))
  if (allRows.length === 0) return ""

  // Separate header rows (th cells or role=columnheader) from data rows
  const headerRows = allRows.filter((r) =>
    r.querySelector("th, [role=columnheader]") !== null,
  )
  const dataRows = allRows.filter((r) =>
    r.querySelector("th, [role=columnheader]") === null,
  )

  // Only include data rows that are visible in the viewport
  const visibleDataRows = dataRows.filter((row) => {
    const rect = (row as HTMLElement).getBoundingClientRect()
    return rect.bottom > 0 && rect.top < window.innerHeight && rect.height > 0
  })

  const hiddenCount = dataRows.length - visibleDataRows.length
  const rowsToRender = headerRows.length > 0
    ? [...headerRows, ...visibleDataRows]
    : visibleDataRows

  if (rowsToRender.length === 0) return ""

  const lines: string[] = []

  rowsToRender.forEach((row, rowIndex) => {
    const cells = Array.from(row.querySelectorAll("th, td, [role=gridcell], [role=columnheader]"))
    const cellTexts = cells.map((cell) => {
      const interactable = cell.querySelector<Element>(SEMANTIC_SELECTOR)
      if (interactable) {
        const eid = inverseRegistry.get(interactable)
        if (eid !== undefined) {
          const tag = interactable.tagName.toLowerCase()
          return `[${tag.charAt(0).toUpperCase() + tag.slice(1)}: ID ${eid}]`
        }
      }
      return cell.textContent?.trim().replace(/\s+/g, " ") ?? ""
    })

    lines.push("| " + cellTexts.join(" | ") + " |")
    if (rowIndex === 0) {
      lines.push("|" + cellTexts.map(() => "---").join("|") + "|")
    }
  })

  if (hiddenCount > 0) {
    lines.push(`(${hiddenCount} more rows off-screen — scroll to reveal)`)
  }

  return lines.join("\n")
}

function isInsideGrid(el: Element, gridSelector: string): boolean {
  return el.closest(gridSelector) !== null
}

function collectDisplayBlocks(gridSelector: string): Set<Element> {
  const candidates: Element[] = []

  document.querySelectorAll<Element>("div, span, p, li, dd, dt").forEach((el) => {
    if (!isVisible(el)) return
    if (isInsideGrid(el, gridSelector)) return
    if (el.querySelector(SEMANTIC_SELECTOR) !== null) return
    const text = el.textContent?.trim().replace(/\s+/g, " ") ?? ""
    if (text.length < 3) return
    candidates.push(el)
  })

  // Keep only outermost qualifying containers — drop descendants of already-kept elements
  const kept = new Set<Element>()
  for (const el of candidates) {
    let dominated = false
    for (const other of kept) {
      if (other.contains(el)) {
        dominated = true
        break
      }
    }
    if (!dominated) {
      // Remove any already-kept elements that are descendants of this one
      for (const other of kept) {
        if (el.contains(other)) kept.delete(other)
      }
      kept.add(el)
    }
  }

  return kept
}

function buildHybridTree(registry: Map<number, Element>, inverseRegistry: Map<Element, number>): string {
  const sections: string[] = []

  const gridSelector = "table, [role=grid], [role=table]"

  const visibleLines: string[] = []
  const gridSections: string[] = []
  const displayBlocks   = collectDisplayBlocks(gridSelector)
  const visibleEntries: Array<{ el: Element; line: string }> = []

  // Process grids — outermost only to avoid one section per row in flat-table layouts
  const allGrids = Array.from(document.querySelectorAll<Element>(gridSelector))
  const outerGrids = allGrids.filter(
    (g) => !allGrids.some((other) => other !== g && other.contains(g)),
  )
  outerGrids.forEach((grid) => {
    const gridMd = linearizeGrid(grid, inverseRegistry)
    if (gridMd) {
      const heading = grid.querySelector("caption, [role=caption]")?.textContent?.trim()
      const label = heading ? `=== ${heading.toUpperCase()} GRID ===` : "=== DATA GRID ==="
      gridSections.push(label + "\n" + gridMd)
    }
  })

  // Stage display blocks for DOM-ordered emit — skip invisible/zero-size containers
  // and truncate long text so the element map stays within token limits.
  for (const el of displayBlocks) {
    const rect = (el as HTMLElement).getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) continue
    const style = window.getComputedStyle(el as HTMLElement)
    if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") continue
    const full = el.textContent?.trim().replace(/\s+/g, " ") ?? ""
    const text = full.length > 120 ? full.slice(0, 120) + "…" : full
    visibleEntries.push({ el, line: `[TEXT]: "${text}"` })
  }

  // Process interactables — visible only, agent scrolls to reveal off-screen content
  for (const [eid, el] of registry) {
    if (isInsideGrid(el, gridSelector)) continue
    if (!isVisible(el)) continue

    const tag = el.tagName.toLowerCase()
    const ariaLabelledBy = (el as HTMLElement).getAttribute("aria-labelledby")
    const labelledByText = ariaLabelledBy
      ? document.getElementById(ariaLabelledBy)?.textContent?.trim() ?? ""
      : ""
    const rawText =
      labelledByText ||
      el.textContent?.trim().replace(/\s+/g, " ") ||
      (el as HTMLInputElement).placeholder ||
      (el as HTMLElement).getAttribute("aria-label") ||
      ""
    const text = rawText.length > 80 ? rawText.slice(0, 80) + "…" : rawText
    const role = el.getAttribute("role") ?? ""

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

    visibleEntries.push({ el, line: label })
  }

  // Emit visible entries in DOM order
  visibleEntries.sort((a, b) => {
    const pos = a.el.compareDocumentPosition(b.el)
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1
    return 0
  })
  for (const { line } of visibleEntries) {
    visibleLines.push(line)
  }

  // Add semantic text (headings + labels) for visible viewport
  const semanticVisible: string[] = []
  document.querySelectorAll<Element>("h1, h2, h3, label").forEach((el) => {
    if (!isVisible(el)) return
    if (isInsideGrid(el, gridSelector)) return
    // Skip elements whose content is already captured inside a display block
    for (const block of displayBlocks) {
      if (block.contains(el)) return
    }
    const tag = el.tagName.toLowerCase()
    const text = el.textContent?.trim().replace(/\s+/g, " ") ?? ""
    if (!text) return
    semanticVisible.push(`[${tag.toUpperCase()}]: "${text}"`)
  })

  if (semanticVisible.length > 0 || visibleLines.length > 0) {
    sections.push([...semanticVisible, ...visibleLines].join("\n"))
  }

  if (gridSections.length > 0) {
    sections.push(gridSections.join("\n\n"))
  }

  return sections.join("\n\n")
}

async function captureScreenshot(): Promise<string> {
  return new Promise((resolve, _reject) => {
    screenshotResolve = (dataUrl) => resizeScreenshot(dataUrl).then(resolve).catch(() => resolve(""))
    relayPort.postMessage({ type: "capture_screenshot_request" })
  })
}

async function resizeScreenshot(dataUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onerror = () => reject(new Error("Failed to load screenshot for resizing"))
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
      resolve(canvas.toDataURL("image/jpeg", 0.75))
    }
    img.src = dataUrl
  })
}

async function handleSnapshotRequest(taskId: string, taskType: DomTaskType): Promise<void> {
  const { registry, inverseRegistry } = collectInteractables()
  elementRegistry.set(taskId, registry)

  const elementMap = buildHybridTree(registry, inverseRegistry)
  console.log(`[compass] snapshot taskId=${taskId} elementCount=${registry.size}`)
  const screenshot = await captureScreenshot()

  const msg: OutboundMessage = {
    type:     "dom_snapshot",
    taskId,
    taskType,
    screenshot,
    elementMap,
  }
  relayToBackground(msg)
}
