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

// Fixed reconnect schedule. After all attempts are exhausted the session is
// torn down and the user must click the pill again to start fresh.
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 8000, 8000]

// Outbound queue: messages sent while the WS is not yet open are buffered
// and flushed in FIFO order when the WS opens.
const outboundQueue: OutboundExtensionMessage[] = []
const MAX_QUEUE = 50

type ConnectionStatus = "ok" | "degraded" | "disconnected"

let ws: WebSocket | null = null
let sessionId: string | null = null
// The tab that owns the active session. Captured from sender.tab on
// session_start. chrome.tabs.query({active, currentWindow}) is unreliable
// from a service worker — focus may be on DevTools or another window when
// a server message arrives, dropping relays silently.
let sessionTabId: number | null = null
let attempt = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let bufferPollTimer: ReturnType<typeof setInterval> | null = null
// Starts at "ok" so the first ws.onclose actually broadcasts a state change
// even though the WS hasn't connected yet.
let connectionStatus: ConnectionStatus = "ok"
let highSince: number | null = null
let lowSince:  number | null = null

function relayToSessionTab(msg: ServerMessage) {
  if (sessionTabId === null) {
    console.warn("[compass] dropping server message — no session tab tracked", { type: msg.type })
    return
  }
  chrome.tabs.sendMessage(sessionTabId, msg).catch(() => {})
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

// Decide what bytes to send for a given outbound message. Returns the shaped
// ExtensionMessage ready for JSON.stringify, or null if the message must be
// dropped (e.g. non-session message with no active sessionId).
function prepareForWire(message: OutboundExtensionMessage): ExtensionMessage | null {
  const msgType = (message as { type: string }).type
  // session_start / session_end / session_resume don't get a sessionId
  // attached by us — they're either id-less or carry their own.
  if (msgType === "session_start" || msgType === "session_end" || msgType === "session_resume") {
    return message as ExtensionMessage
  }
  // All other messages require an active session
  if (!sessionId) {
    console.warn("[compass] dropping message — no active session", msgType)
    return null
  }
  return { ...message, sessionId } as ExtensionMessage
}

// Flush all queued outbound messages through the now-open WebSocket.
// Called at the top of ws.onopen, before the session-resume probe.
function flushQueue() {
  if (outboundQueue.length === 0) return
  console.log(`[compass] flushing ${outboundQueue.length} queued message(s)`)
  while (outboundQueue.length > 0) {
    const msg = outboundQueue.shift()!
    const wire = prepareForWire(msg)
    if (wire === null) continue
    ws!.send(JSON.stringify(wire))
    // Mirror the session_end side-effect so state stays consistent.
    if ((wire as { type: string }).type === "session_end") sessionId = null
  }
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

    // Drain any messages that arrived before the WS was ready.
    flushQueue()

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

    relayToSessionTab(msg)
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
  if (attempt >= RECONNECT_DELAYS_MS.length) {
    console.warn("[compass] reconnect attempts exhausted — tearing down session")
    sessionId = null
    sessionTabId = null
    // connectionStatus is already "disconnected"; pill UI handles this state.
    // Future reconnection only happens when the user clicks the pill again,
    // which triggers session_start → sendRaw → connect() kick.
    return
  }

  const delayMs = RECONNECT_DELAYS_MS[attempt]
  const delaySec = Math.round(delayMs / 1000)
  console.log(`[compass] reconnecting in ${delaySec}s (attempt ${attempt + 1}/${RECONNECT_DELAYS_MS.length})`)
  attempt += 1
  reconnectTimer = setTimeout(connect, delayMs)
}

function sendRaw(message: OutboundExtensionMessage) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    const wire = prepareForWire(message)
    if (wire === null) return
    ws.send(JSON.stringify(wire))
    if ((wire as { type: string }).type === "session_end") sessionId = null
    return
  }

  // WS is not open — enqueue the message to be flushed when it opens.
  if (outboundQueue.length >= MAX_QUEUE) {
    const dropped = outboundQueue.shift()
    console.warn("[compass] outbound queue full — dropped oldest message", (dropped as { type: string }).type)
  }
  outboundQueue.push(message)

  // If the WS is gone (null) and no reconnect is already scheduled, kick a
  // fresh connect(). This covers: (a) cold extension load before first open,
  // and (b) user click after reconnect was exhausted (sessionId will be null
  // at that point, so connect() won't attempt session_resume).
  if (ws === null && reconnectTimer === null) {
    console.log("[compass] WS not open — starting connect() for queued message")
    attempt = 0
    connect()
  }
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
chrome.runtime.onMessage.addListener((message: OutboundExtensionMessage, sender, _sendResponse) => {
  // Track which tab owns the session so server messages relay back to the
  // right place even when focus is elsewhere (DevTools, another window).
  // We adopt the tab id on any content-script-originated message during a
  // session — session_start may race with audio_chunks, and a missed capture
  // there would leave sessionTabId null and silently drop every server reply.
  if (message.type === "session_end") {
    sessionTabId = null
  } else if (sender.tab?.id !== undefined && sessionTabId === null) {
    sessionTabId = sender.tab.id
  }
  sendRaw(message)
  return false
})

connect()

chrome.runtime.onInstalled.addListener(() => {})
chrome.runtime.onStartup.addListener(() => {})
