/// <reference types="chrome" />
import type { ExtensionMessage, ServerMessage, DomTaskType, WebIntent } from "@compass-ai/types"

type StripSessionId<T> = T extends { sessionId: string } ? Omit<T, "sessionId"> : T
type OutboundMessage = StripSessionId<ExtensionMessage>

// Persists between snapshot (dom_snapshot_request) and action execution (action)
export const elementRegistry = new Map<string, Map<number, Element>>()
//                                      taskId    elementId  element

chrome.runtime.onMessage.addListener((msg: ServerMessage) => {
  if (msg.type === "dom_snapshot_request") {
    handleSnapshotRequest(msg.taskId, msg.taskType).catch(console.error)
    return false
  }
  if (msg.type === "action") {
    handleAction(msg.taskId, msg.actionId, msg.intent)
      .then((result) => {
        const reply: OutboundMessage = {
          type:     "action_result",
          actionId: msg.actionId,
          taskId:   msg.taskId,
          success:  result.success,
          ...(result.error ? { error: result.error } : {}),
        }
        chrome.runtime.sendMessage(reply, () => {
          if (chrome.runtime.lastError) {
            console.error("[compass] action_result send failed:", chrome.runtime.lastError.message)
          }
        })
      })
      .catch((err: unknown) => {
        const error = err instanceof Error ? err.message : String(err)
        const reply: OutboundMessage = {
          type:     "action_result",
          actionId: msg.actionId,
          taskId:   msg.taskId,
          success:  false,
          error,
        }
        chrome.runtime.sendMessage(reply, () => {
          if (chrome.runtime.lastError) {
            console.error("[compass] action_result send failed:", chrome.runtime.lastError.message)
          }
        })
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

async function executeIntent(intent: WebIntent, registry: Map<number, Element>): Promise<void> {
  if (intent.action === "click") {
    const el = registry.get(intent.element_id)
    if (!el) throw new Error(`Element ID ${intent.element_id} not found`)
    ;(el as HTMLElement).click()
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

function collectInteractables(): { registry: Map<number, Element>; inverseRegistry: Map<Element, number> } {
  const registry = new Map<number, Element>()
  const inverseRegistry = new Map<Element, number>()
  const seen = new Set<Element>()
  let id = 1

  document.querySelectorAll<Element>(INTERACTABLE_SELECTOR).forEach((el) => {
    seen.add(el)
    registry.set(id, el)
    inverseRegistry.set(el, id)
    id++
  })

  document.querySelectorAll<Element>("*").forEach((el) => {
    if (isScrollableContainer(el) && !seen.has(el)) {
      seen.add(el)
      registry.set(id, el)
      inverseRegistry.set(el, id)
      id++
    }
  })

  return { registry, inverseRegistry }
}

function linearizeGrid(table: Element, inverseRegistry: Map<Element, number>): string {
  const rows = Array.from(table.querySelectorAll("tr, [role=row]"))
  if (rows.length === 0) return ""

  const lines: string[] = []

  rows.forEach((row, rowIndex) => {
    const cells = Array.from(row.querySelectorAll("th, td, [role=gridcell], [role=columnheader]"))
    const cellTexts = cells.map((cell) => {
      const interactable = cell.querySelector<Element>(INTERACTABLE_SELECTOR)
      if (interactable) {
        const eid = inverseRegistry.get(interactable)
        if (eid !== undefined) {
          const tag = interactable.tagName.toLowerCase()
          return `[${tag.charAt(0).toUpperCase() + tag.slice(1)}: ID ${eid}]`
        }
      }
      return cell.textContent?.trim().replace(/\s+/g, " ") ?? ""
    })

    if (rowIndex === 0) {
      lines.push("| " + cellTexts.join(" | ") + " |")
      lines.push("|" + cellTexts.map(() => "---").join("|") + "|")
    } else {
      lines.push("| " + cellTexts.join(" | ") + " |")
    }
  })

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
    if (el.querySelector(INTERACTABLE_SELECTOR) !== null) return
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

  const visibleLines:   string[] = []
  const offscreenLines: string[] = []
  const gridSections:   string[] = []
  const displayBlocks   = collectDisplayBlocks(gridSelector)

  // Process grids first
  document.querySelectorAll<Element>(gridSelector).forEach((grid) => {
    const gridMd = linearizeGrid(grid, inverseRegistry)
    if (gridMd) {
      const heading = grid.querySelector("caption, [role=caption]")?.textContent?.trim()
      const label = heading ? `=== ${heading.toUpperCase()} GRID ===` : "=== DATA GRID ==="
      gridSections.push(label + "\n" + gridMd)
    }
  })

  // Emit display blocks — visible containers with no interactable descendants
  for (const el of displayBlocks) {
    const text = el.textContent?.trim().replace(/\s+/g, " ") ?? ""
    visibleLines.push(`[TEXT]: "${text}"`)
  }

  // Process interactables
  for (const [eid, el] of registry) {
    // Skip elements inside a grid (already captured above)
    if (isInsideGrid(el, gridSelector)) continue

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
    if (isInsideGrid(el, gridSelector)) return
    // Skip labels whose content is already captured inside a display block
    if (el.tagName.toLowerCase() === "label") {
      for (const block of displayBlocks) {
        if (block.contains(el)) return
      }
    }
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

async function captureScreenshot(): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "capture_screenshot_request" }, (response: { dataUrl: string } | undefined) => {
      if (chrome.runtime.lastError || !response) {
        reject(new Error(chrome.runtime.lastError?.message ?? "No screenshot response"))
        return
      }
      resizeScreenshot(response.dataUrl).then(resolve).catch(reject)
    })
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
      resolve(canvas.toDataURL("image/webp", 0.75))
    }
    img.src = dataUrl
  })
}

async function handleSnapshotRequest(taskId: string, taskType: DomTaskType): Promise<void> {
  const { registry, inverseRegistry } = collectInteractables()
  elementRegistry.set(taskId, registry)

  const elementMap = buildHybridTree(registry, inverseRegistry)
  const screenshot = await captureScreenshot()

  const msg: OutboundMessage = {
    type:     "dom_snapshot",
    taskId,
    taskType,
    screenshot,
    elementMap,
  }
  chrome.runtime.sendMessage(msg, () => {
    if (chrome.runtime.lastError) {
      console.error("[compass] dom_snapshot send failed:", chrome.runtime.lastError.message)
    }
  })
}
