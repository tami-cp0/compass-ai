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

// Uplink congestion thresholds. Buffer climbing above HIGH for ENTER_MS
// means user audio is no longer reaching the server in real time.
const BUFFER_HIGH_BYTES = 40_000
const DEGRADED_ENTER_MS = 1_000
const DEGRADED_EXIT_MS  = 1_000
const BUFFER_POLL_MS    = 250

type ConnectionStatus = "ok" | "degraded" | "disconnected"

let ws: WebSocket | null = null
let sessionId: string | null = null
let attempt = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let bufferPollTimer: ReturnType<typeof setInterval> | null = null
// Starts at "ok" so the first ws.onclose actually broadcasts a state change
// even though the WS hasn't connected yet.
let connectionStatus: ConnectionStatus = "ok"
let highSince: number | null = null
let lowSince:  number | null = null

function relayToActiveTab(msg: ServerMessage) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0]
    if (!tab?.id) return
    chrome.tabs.sendMessage(tab.id, msg).catch(() => {})
  })
}

// Status changes need to reach the pill regardless of which tab is "active"
// — chrome.tabs.query with currentWindow is unreliable from a service worker.
function broadcastToAllTabs(msg: ServerMessage) {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (!tab.id) continue
      chrome.tabs.sendMessage(tab.id, msg).catch(() => {})
    }
  })
}

function setConnectionStatus(next: ConnectionStatus) {
  if (next === connectionStatus) return
  connectionStatus = next
  broadcastToAllTabs({ type: "connection_status", status: next })
}

function startBufferWatch() {
  if (bufferPollTimer !== null) return
  highSince = null
  lowSince  = null
  bufferPollTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const buffered = ws.bufferedAmount
    const now = Date.now()
    if (buffered > BUFFER_HIGH_BYTES) {
      lowSince = null
      if (highSince === null) highSince = now
      if (connectionStatus === "ok" && now - highSince >= DEGRADED_ENTER_MS) {
        setConnectionStatus("degraded")
      }
    } else {
      highSince = null
      if (lowSince === null) lowSince = now
      if (connectionStatus === "degraded" && now - lowSince >= DEGRADED_EXIT_MS) {
        setConnectionStatus("ok")
      }
    }
  }, BUFFER_POLL_MS)
}

function stopBufferWatch() {
  if (bufferPollTimer !== null) {
    clearInterval(bufferPollTimer)
    bufferPollTimer = null
  }
  highSince = null
  lowSince  = null
}

function connect() {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  ws = new WebSocket(WS_URL)

  ws.onopen = () => {
    attempt = 0
    setConnectionStatus("ok")
    startBufferWatch()
    if (sessionId) {
      console.log(`[compass] WS reconnected — resuming session ${sessionId}`)
      ws!.send(JSON.stringify({ type: "session_resume", sessionId } satisfies ExtensionMessage))
    } else {
      console.log("[compass] WS connected — waiting for mic to start session")
    }
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

    relayToActiveTab(msg)
  }

  ws.onclose = () => {
    // sessionId is intentionally NOT cleared — onopen uses it to resume.
    ws = null
    stopBufferWatch()
    setConnectionStatus("disconnected")
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
  // session_start / session_end / session_resume don't get a sessionId
  // attached by us — they're either id-less or carry their own.
  const msgType = (message as { type: string }).type
  if (msgType === "session_start" || msgType === "session_end" || msgType === "session_resume") {
    ws.send(JSON.stringify(message))
    if (msgType === "session_end") sessionId = null
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
