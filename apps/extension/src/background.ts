/// <reference types="chrome" />

import type { ExtensionMessage, ServerMessage } from "@compass-ai/types"

type StripSessionId<T> = T extends { sessionId: string }
  ? Omit<T, "sessionId">
  : T
type OutboundExtensionMessage = StripSessionId<ExtensionMessage>

const WS_URL = "ws://localhost:8787/ws"

let ws: WebSocket | null = null
let sessionId: string | null = null
let attempt = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

function connect() {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  ws = new WebSocket(WS_URL)

  ws.onopen = () => {
    // sessionId is assigned by the server via session_init — wait for it
  }

  ws.onmessage = (event: MessageEvent<string>) => {
    let msg: ServerMessage
    try {
      msg = JSON.parse(event.data) as ServerMessage
    } catch {
      console.warn("[compass] unparseable message from server")
      return
    }

    if (msg.type === "session_init") {
      sessionId = msg.sessionId
      attempt = 0
      console.log(`[compass] connected, sessionId: ${sessionId}`)
      return
    }

    // Relay all other ServerMessages to the active tab's content script
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0]
      if (!tab?.id) {
        console.warn("[compass] no active tab to relay message to", msg.type)
        return
      }
      chrome.tabs.sendMessage(tab.id, msg).catch(() => {
        // Content scripts not loaded yet — swallow
      })
    })
  }

  ws.onclose = () => {
    sessionId = null
    ws = null
    scheduleReconnect()
  }

  ws.onerror = () => {
    // onclose fires after onerror — reconnect is handled there
  }
}

function scheduleReconnect() {
  attempt += 1
  const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 30_000)
  const delaySec = Math.round(delayMs / 1000)
  console.log(`[compass] reconnecting in ${delaySec}s (attempt ${attempt})`)
  reconnectTimer = setTimeout(connect, delayMs)
}

// Handle screenshot capture requests from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "capture_screenshot_request") return false
  const windowId = sender.tab?.windowId
  chrome.tabs.captureVisibleTab(
    windowId,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { format: "webp", quality: 75 } as any,
    (dataUrl: string) => { sendResponse({ dataUrl }) }
  )
  return true // keep channel open for async response
})

// Relay outbound messages from content scripts to the gateway
chrome.runtime.onMessage.addListener((message: OutboundExtensionMessage | { type: "capture_screenshot_request" }) => {
  if (message.type === "capture_screenshot_request") return false
  if (!ws || ws.readyState !== WebSocket.OPEN || !sessionId) {
    console.warn("[compass] dropping message — not connected", message)
    return
  }
  const outbound: ExtensionMessage = {
    ...message,
    sessionId
  } as ExtensionMessage
  ws.send(JSON.stringify(outbound))
})

// Call connect() at module scope so it runs every time the service worker is instantiated
connect()

chrome.runtime.onInstalled.addListener(() => {})
chrome.runtime.onStartup.addListener(() => {})
