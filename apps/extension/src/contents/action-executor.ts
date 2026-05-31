/// <reference types="chrome" />
import type { ExtensionMessage, ServerMessage, WebIntent } from "@compass-ai/types"

import { elementRegistry } from "./dom-watcher"

type StripSessionId<T> = T extends { sessionId: string } ? Omit<T, "sessionId"> : T
type OutboundMessage = StripSessionId<ExtensionMessage>

chrome.runtime.onMessage.addListener((msg: ServerMessage) => {
  if (msg.type !== "action") return false
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
})

async function handleAction(
  taskId:   string,
  _actionId: string,
  intent:   WebIntent,
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
    const input = el as HTMLInputElement | HTMLTextAreaElement
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
