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

function buildHybridTree(registry: Map<number, Element>, inverseRegistry: Map<Element, number>): string {
  const sections: string[] = []

  const gridSelector = "table, [role=grid], [role=table]"

  const visibleLines:   string[] = []
  const offscreenLines: string[] = []
  const gridSections:   string[] = []

  // Process grids first
  document.querySelectorAll<Element>(gridSelector).forEach((grid) => {
    const gridMd = linearizeGrid(grid, inverseRegistry)
    if (gridMd) {
      const heading = grid.querySelector("caption, [role=caption]")?.textContent?.trim()
      const label = heading ? `=== ${heading.toUpperCase()} GRID ===` : "=== DATA GRID ==="
      gridSections.push(label + "\n" + gridMd)
    }
  })

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
