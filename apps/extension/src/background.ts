/// <reference types="chrome" />

import type { ExtensionMessage, ServerMessage } from "@compass-ai/types"

type StripSessionId<T> = T extends { sessionId: string }
  ? Omit<T, "sessionId">
  : T
type OutboundExtensionMessage = StripSessionId<ExtensionMessage>

const WS_URL = process.env.PLASMO_PUBLIC_WS_URL
if (!WS_URL) {
  throw new Error("PLASMO_PUBLIC_WS_URL is not set — build aborted")
}

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
    attempt = 0
    console.log("[compass] WS connected — waiting for mic to start session")
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
      console.log(`[compass] session started, sessionId: ${sessionId}`)
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

function sendRaw(message: OutboundExtensionMessage) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.warn("[compass] dropping message — WS not open", (message as { type: string }).type)
    return
  }
  // session_start / session_end have no sessionId — send as-is
  const msgType = (message as { type: string }).type
  if (msgType === "session_start" || msgType === "session_end") {
    ws.send(JSON.stringify(message))
    return
  }
  // All other messages require an active session
  if (!sessionId) {
    console.warn("[compass] dropping message — no active session", (message as { type: string }).type)
    return
  }
  const outbound: ExtensionMessage = { ...message, sessionId } as ExtensionMessage
  ws.send(JSON.stringify(outbound))
}

// Persistent port from content script — keeps the service worker alive so async
// operations (captureVisibleTab, WebSocket sends) always complete.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "compass-relay") return

  port.onMessage.addListener((message: OutboundExtensionMessage | { type: "capture_screenshot_request" }) => {
    if (message.type === "capture_screenshot_request") {
      const windowId = port.sender?.tab?.windowId ?? chrome.windows.WINDOW_ID_CURRENT
      chrome.tabs.captureVisibleTab(
        windowId,
        { format: "jpeg", quality: 75 },
        (dataUrl: string) => {
          if (chrome.runtime.lastError || !dataUrl) {
            console.error("[compass] captureVisibleTab failed:", chrome.runtime.lastError?.message)
            port.postMessage({ type: "capture_screenshot_response", dataUrl: "" })
            return
          }
          port.postMessage({ type: "capture_screenshot_response", dataUrl })
        }
      )
      return
    }

    sendRaw(message as OutboundExtensionMessage)
  })
})

// Relay fire-and-forget messages from pill.tsx (audio_chunk, session_start, session_end, user_action_result).
chrome.runtime.onMessage.addListener((message: OutboundExtensionMessage, _sender, _sendResponse) => {
  sendRaw(message)
  return false
})

connect()

chrome.runtime.onInstalled.addListener(() => {})
chrome.runtime.onStartup.addListener(() => {})
