/// <reference types="chrome" />

import type { AgentAction, ExtensionMessage, ServerMessage } from "@compass-ai/types"

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

// Web-agent screenshots ship at physical resolution (capped at MAX_LONG_EDGE_PX
// for the model's image limit). The model's coords come back in that image
// space; the server scales them to CSS pixels for CDP dispatch.

const DEBUGGER_PROTOCOL_VERSION = "1.3"

// CDP timing. Atlass navigates in-SPA (no document reload), so readyState is
// often already "complete" and says nothing about whether the page's data has
// loaded — the holdings table renders empty, then fills after an XHR. So after
// readyState we wait for DOM QUIESCENCE: poll a cheap content signature and
// only proceed once it stops changing for DOM_IDLE_MS, capped at
// STABILITY_TIMEOUT_MS. This stops the agent screenshotting mid-fetch.
const STABILITY_TIMEOUT_MS = 6000
const DOM_POLL_MS = 150
const DOM_IDLE_MS = 500
const TOTAL_TYPING_DELAY_MS = 500
const MOUSE_MOVE_STEPS = 5
const DRAG_HOLD_MS = 500

const isMac =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (navigator as any).userAgentData?.platform === "macOS" ||
  navigator.userAgent.includes("Mac")

// Outbound queue: messages sent while the WS is not yet open are buffered
// and flushed in FIFO order when the WS opens.
const outboundQueue: OutboundExtensionMessage[] = []
const MAX_QUEUE = 50

type ConnectionStatus = "ok" | "degraded" | "disconnected"

let ws: WebSocket | null = null
let sessionId: string | null = null
// The tab that owns the active session, captured from sender.tab on
// session_start. chrome.tabs.query({active}) is unreliable from a service
// worker (focus may be on DevTools/another window), silently dropping relays.
let sessionTabId: number | null = null
let attempt = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let bufferPollTimer: ReturnType<typeof setInterval> | null = null
let connectionStatus: ConnectionStatus = "ok"
let highSince: number | null = null
let lowSince:  number | null = null

// Vision stream: while on, capture a frame every VISION_FRAME_MS and push it to
// the server. 1 fps is the Live API's max useful rate. The server owns the
// on/off lifetime (glance/sustained + hard cap); the extension just runs/stops
// the loop. Structured so a "user speaking" flag could later throttle idle
// frames — the server-side auto-off + cap already bound idle cost for now.
const VISION_FRAME_MS = 1000
let visionTimer: ReturnType<typeof setInterval> | null = null
let visionCapturing = false

// ─── Helpers ─────────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function relayToSessionTab(msg: ServerMessage) {
  if (sessionTabId === null) {
    console.warn("[compass] dropping server message — no session tab tracked", { type: msg.type })
    return
  }
  chrome.tabs.sendMessage(sessionTabId, msg).catch(() => {})
}

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

function prepareForWire(message: OutboundExtensionMessage): ExtensionMessage | null {
  const msgType = (message as { type: string }).type
  if (msgType === "session_start" || msgType === "session_end" || msgType === "session_resume") {
    return message as ExtensionMessage
  }
  if (!sessionId) {
    console.warn("[compass] dropping message — no active session", msgType)
    return null
  }
  return { ...message, sessionId } as ExtensionMessage
}

function flushQueue() {
  if (outboundQueue.length === 0) return
  console.log(`[compass] flushing ${outboundQueue.length} queued message(s)`)
  while (outboundQueue.length > 0) {
    const msg = outboundQueue.shift()!
    const wire = prepareForWire(msg)
    if (wire === null) continue
    ws!.send(JSON.stringify(wire))
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

    // Agent control messages are handled here in background — content scripts
    // can't drive chrome.debugger.
    if (msg.type === "agent_observation_request") {
      void handleObservationRequest(msg.taskId)
      return
    }
    if (msg.type === "agent_action") {
      void handleAction(msg.taskId, msg.actionId, msg.action)
      return
    }
    if (msg.type === "automation_end") {
      void detachAgentDebugger()
      relayToSessionTab(msg) // let pill UI know the run ended
      return
    }

    if (msg.type === "screenshot_request") {
      void handleGeminiScreenshotRequest(msg.requestId)
      return
    }

    if (msg.type === "vision_start") {
      startVision()
      relayToSessionTab(msg) // pill vision indicator
      return
    }
    if (msg.type === "vision_stop") {
      stopVision()
      relayToSessionTab(msg)
      return
    }

    if (msg.type === "page_data_request") {
      void handlePageDataRequest(msg.requestId, msg.box, msg.physicalPixels)
      return
    }

    relayToSessionTab(msg)
  }

  ws.onclose = () => {
    ws = null
    stopBufferWatch()
    stopVision() // socket down — no frames until reconnect re-enables
    setConnectionStatus("disconnected")
    scheduleReconnect()
  }

  ws.onerror = () => {}
}

function scheduleReconnect() {
  if (attempt >= RECONNECT_DELAYS_MS.length) {
    console.warn("[compass] reconnect attempts exhausted — tearing down session")
    sessionId = null
    sessionTabId = null
    stopVision()
    void detachAgentDebugger()
    broadcastToAllTabs({ type: "pin_pane_clear", sessionId: "" })
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

  if (outboundQueue.length >= MAX_QUEUE) {
    const dropped = outboundQueue.shift()
    console.warn("[compass] outbound queue full — dropped oldest message", (dropped as { type: string }).type)
  }
  outboundQueue.push(message)

  if (ws === null && reconnectTimer === null) {
    console.log("[compass] WS not open — starting connect() for queued message")
    attempt = 0
    connect()
  }
}

// ─── Screenshot capture + resize (service-worker safe) ───────────────────────

interface CapturedFrame {
  base64: string   // raw base64 PNG (no data: prefix)
  width: number    // image width in px (the space the model's coords are in)
  height: number   // image height in px
  cssWidth: number  // CSS viewport width (what CDP dispatch expects)
  cssHeight: number // CSS viewport height
}

// Sonnet 5 accepts up to this many px on the long edge before the API
// downscales. We capture at physical resolution (sharpest grounding) but cap
// here so we never exceed it or upscale past what the display actually has.
const MAX_LONG_EDGE_PX = 2576

async function captureFromTab(tabId: number): Promise<CapturedFrame> {
  const tab = await chrome.tabs.get(tabId)
  // PNG: lossless capture. JPEG would discard high-frequency detail (text,
  // edges) before we ever look at the bitmap.
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: "png",
  })
  if (!dataUrl) throw new Error("captureVisibleTab returned empty")

  const [dpr, vw, vh] = await readViewport(tabId)

  // Source bitmap is at physical pixels (vw × dpr, vh × dpr).
  const sourceBlob = await (await fetch(dataUrl)).blob()
  const sourceBitmap = await createImageBitmap(sourceBlob)

  // Output at physical resolution for the sharpest detail the model is allowed
  // to see, but never above MAX_LONG_EDGE_PX (else the API downscales and we
  // lose the scale factor). The model's coords come back in this image space;
  // the server scales them to CSS pixels for CDP using cssWidth/cssHeight.
  const physW = Math.round(vw * dpr)
  const physH = Math.round(vh * dpr)
  const longEdge = Math.max(physW, physH)
  const scale = longEdge > MAX_LONG_EDGE_PX ? MAX_LONG_EDGE_PX / longEdge : 1
  const outW = Math.max(1, Math.round(physW * scale))
  const outH = Math.max(1, Math.round(physH * scale))

  const canvas = new OffscreenCanvas(outW, outH)
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("Failed to acquire 2D canvas context")
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = "high"
  ctx.drawImage(sourceBitmap, 0, 0, outW, outH)

  const outBlob = await canvas.convertToBlob({ type: "image/png" })
  const base64 = await blobToBase64(outBlob)

  return { base64, width: outW, height: outH, cssWidth: vw, cssHeight: vh }
}

async function readViewport(tabId: number): Promise<[number, number, number]> {
  let results: chrome.scripting.InjectionResult<[number, number, number]>[]
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        return [
          window.devicePixelRatio || 1,
          window.innerWidth,
          window.innerHeight,
        ] as [number, number, number]
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // chrome:// pages, chrome web store, and pages without host permission
    // all surface here. Make the cause obvious instead of leaking
    // "Cannot access contents of url" verbatim.
    if (msg.includes("Cannot access") || msg.includes("Missing host permission")) {
      throw new Error(
        "Cannot read viewport: the agent does not have access to this page. " +
        "Chrome system pages (chrome://, chromewebstore) and some restricted URLs " +
        "block extensions. Navigate to a normal http(s) page and try again.",
      )
    }
    if (msg.includes("scripting") || msg.includes("permission")) {
      throw new Error(
        'Cannot read viewport: the extension is missing the "scripting" permission. ' +
        'Reload the extension and grant the new permission when prompted.',
      )
    }
    throw new Error(`Cannot read viewport from tab ${tabId}: ${msg}`)
  }
  const r = results[0]?.result as [number, number, number] | undefined
  if (!r) throw new Error("Cannot read viewport: executeScript returned no result (page may have navigated mid-capture)")
  return r
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ""
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

// Gemini Live screenshot tool. The live model emits no coordinates, so it needs
// no coordinate space — send the raw physical-resolution PNG for maximum detail
// (captureFromTab, used by the web agent, caps and tracks scale for its coords).
async function handleGeminiScreenshotRequest(requestId: string): Promise<void> {
  try {
    if (sessionTabId === null) {
      sendRaw({ type: "screenshot_response", requestId, dataUrl: "" })
      return
    }
    const base64 = await captureRawFrame()
    sendRaw({ type: "screenshot_response", requestId, dataUrl: base64 })
  } catch (err) {
    console.error("[compass] gemini screenshot failed:", err)
    sendRaw({ type: "screenshot_response", requestId, dataUrl: "" })
  }
}

// Capture the current tab as a raw physical-resolution PNG (base64, no prefix).
// Shared by the one-shot screenshot tool and the continuous vision loop — the
// live model uses no coordinates, so full detail beats downscaling.
async function captureRawFrame(): Promise<string> {
  if (sessionTabId === null) throw new Error("no session tab")
  const tab = await chrome.tabs.get(sessionTabId)
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" })
  if (!dataUrl) throw new Error("captureVisibleTab returned empty")
  return dataUrl.replace(/^data:image\/png;base64,/, "")
}

// ─── Vision stream ───────────────────────────────────────────────────────────

function startVision(): void {
  if (visionTimer !== null) return // already streaming
  const tick = async () => {
    if (visionCapturing || sessionTabId === null) return
    visionCapturing = true
    try {
      const data = await captureRawFrame()
      if (data) sendRaw({ type: "vision_frame", data })
    } catch (err) {
      console.error("[compass] vision frame failed:", err)
    } finally {
      visionCapturing = false
    }
  }
  void tick() // first frame immediately, don't wait a full interval
  visionTimer = setInterval(() => void tick(), VISION_FRAME_MS)
}

function stopVision(): void {
  if (visionTimer !== null) {
    clearInterval(visionTimer)
    visionTimer = null
  }
  visionCapturing = false
}

// ─── Page data extraction (read_page_data tool) ──────────────────────────────
// Returns the exact visible text inside the box the agent drew on its
// screenshot — nothing off-screen or hidden. The box + viewport are the bound,
// so the return is naturally the size of what was asked.
async function handlePageDataRequest(
  requestId: string,
  box: { x: number; y: number; width: number; height: number },
  physicalPixels: boolean,
): Promise<void> {
  try {
    if (sessionTabId === null) throw new Error("no session tab")

    // The box arrives in the caller's screenshot-pixel space. The live agent's
    // frame is physical resolution, so divide by dpr to reach CSS pixels (what
    // the DOM/getBoundingClientRect use); the web agent's frame is already CSS.
    const [dpr] = await readViewport(sessionTabId)
    const scale = physicalPixels && dpr > 0 ? 1 / dpr : 1
    const cssBox = {
      x: box.x * scale,
      y: box.y * scale,
      width: box.width * scale,
      height: box.height * scale,
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId: sessionTabId },
      // Runs in the page. Collects, in reading order, the text of every text
      // node whose own rendered rect (via Range) intersects the box and the
      // viewport — placing each value by where IT sits, not an ancestor's
      // bounds, so it scopes precisely regardless of framework. The TreeWalker
      // doesn't enter shadow roots, so Compass's own overlay is excluded.
      func: (b: { x: number; y: number; width: number; height: number }): string => {
        const vw = window.innerWidth
        const vh = window.innerHeight
        // Clip the box to the viewport — never return off-screen content.
        const left = Math.max(0, b.x)
        const top = Math.max(0, b.y)
        const right = Math.min(vw, b.x + b.width)
        const bottom = Math.min(vh, b.y + b.height)
        if (right <= left || bottom <= top) return ""

        const isVisible = (el: Element): boolean => {
          const s = getComputedStyle(el)
          if (s.visibility === "hidden" || s.display === "none" || s.opacity === "0") return false
          return true
        }

        const picks: Array<{ top: number; left: number; text: string }> = []
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
        let node: Node | null
        while ((node = walker.nextNode())) {
          const text = (node.nodeValue ?? "").replace(/\s+/g, " ").trim()
          if (!text) continue
          const parent = (node as Text).parentElement
          if (!parent || !isVisible(parent)) continue

          const range = document.createRange()
          range.selectNodeContents(node)
          const r = range.getBoundingClientRect()
          if (r.width === 0 || r.height === 0) continue
          // Must intersect the (viewport-clipped) box.
          if (r.right < left || r.left > right || r.bottom < top || r.top > bottom) continue
          picks.push({ top: r.top, left: r.left, text })
        }

        // Reading order: top-to-bottom, then left-to-right within a line band.
        picks.sort((a, z) => (Math.abs(a.top - z.top) > 4 ? a.top - z.top : a.left - z.left))

        const out: string[] = []
        for (const p of picks) {
          if (out.length > 0 && out[out.length - 1] === p.text) continue
          out.push(p.text)
        }
        return out.join("\n")
      },
      args: [cssBox],
    })

    const data = (results[0]?.result as string | undefined) ?? ""
    // DIAGNOSTIC (read_page_data debug): shows the coordinate space so we can
    // see where the box actually lands vs. the live viewport. dpr + viewport
    // reveal whether the box was in normalized/physical/CSS space.
    const [dbgDpr, dbgVw, dbgVh] = await readViewport(sessionTabId)
    console.log("[compass][page-data-debug]", {
      incomingBox: box,
      physicalPixels,
      dpr: dbgDpr,
      viewportCss: { vw: dbgVw, vh: dbgVh },
      cssBoxAfterScale: cssBox,
      chars: data.length,
    })
    sendRaw({ type: "page_data_response", requestId, data, truncated: false })
  } catch (err) {
    console.error("[compass] page data extraction failed:", err)
    sendRaw({
      type: "page_data_response",
      requestId,
      data: "",
      truncated: false,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

// ─── Agent observation ───────────────────────────────────────────────────────

async function handleObservationRequest(taskId: string): Promise<void> {
  try {
    if (sessionTabId === null) throw new Error("no session tab")
    const tab = await chrome.tabs.get(sessionTabId)
    const frame = await captureFromTab(sessionTabId)
    const scrollRegions = await collectScrollRegions(sessionTabId)

    sendRaw({
      type: "agent_observation",
      taskId,
      screenshot: frame.base64,
      width: frame.width,
      height: frame.height,
      cssWidth: frame.cssWidth,
      cssHeight: frame.cssHeight,
      url: tab.url ?? "",
      title: tab.title ?? "",
      scrollRegions,
    })
  } catch (err) {
    console.error("[compass] observation failed:", err)
    sendRaw({
      type: "agent_observation",
      taskId,
      screenshot: "",
      width: 0,
      height: 0,
      cssWidth: 0,
      cssHeight: 0,
      url: "",
      title: "",
    })
  }
}

// Scrollable regions visible in the viewport with their live scroll state, so
// the agent knows before scrolling whether a scroll will do anything.
// Deterministic (scrollHeight vs clientHeight), CSS-pixel coords. [] on failure.
async function collectScrollRegions(tabId: number): Promise<
  Array<{
    x: number; y: number; width: number; height: number
    canScrollDown: boolean; canScrollUp: boolean
    canScrollLeft: boolean; canScrollRight: boolean
    label?: string
  }>
> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const vw = window.innerWidth
        const vh = window.innerHeight
        const EPS = 2
        const out: Array<{
          x: number; y: number; width: number; height: number
          canScrollDown: boolean; canScrollUp: boolean
          canScrollLeft: boolean; canScrollRight: boolean
          label?: string
        }> = []

        const labelFor = (el: Element): string | undefined => {
          const aria = el.getAttribute("aria-label")
          if (aria && aria.trim()) return aria.trim().slice(0, 40)
          // nearest heading inside
          const h = el.querySelector("h1,h2,h3,h4,h5,h6,caption,legend,th")
          const t = (h?.textContent ?? "").trim()
          return t ? t.slice(0, 40) : undefined
        }

        const consider = (el: Element, rect: { left: number; top: number; width: number; height: number }, sTop: number, sLeft: number, sH: number, cH: number, sW: number, cW: number) => {
          const vertical = sH - cH > EPS
          const horizontal = sW - cW > EPS
          if (!vertical && !horizontal) return
          // Must be at least partly on-screen and reasonably sized.
          if (rect.width < 40 || rect.height < 40) return
          if (rect.left > vw || rect.top > vh || rect.left + rect.width < 0 || rect.top + rect.height < 0) return
          out.push({
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            canScrollDown: vertical && sTop + cH < sH - EPS,
            canScrollUp: vertical && sTop > EPS,
            canScrollRight: horizontal && sLeft + cW < sW - EPS,
            canScrollLeft: horizontal && sLeft > EPS,
            label: el === document.scrollingElement ? "page" : labelFor(el),
          })
        }

        // The page itself.
        const se = document.scrollingElement as HTMLElement | null
        if (se) {
          consider(
            se,
            { left: 0, top: 0, width: vw, height: vh },
            se.scrollTop, se.scrollLeft, se.scrollHeight, se.clientHeight, se.scrollWidth, se.clientWidth,
          )
        }

        // Inner scrollers with overflow auto/scroll.
        const all = document.querySelectorAll<HTMLElement>("*")
        for (let i = 0; i < all.length && out.length < 12; i++) {
          const el = all[i]
          if (el === se) continue
          const cs = getComputedStyle(el)
          const oy = cs.overflowY
          const ox = cs.overflowX
          const scrollableStyle = ["auto", "scroll", "overlay"].includes(oy) || ["auto", "scroll", "overlay"].includes(ox)
          if (!scrollableStyle) continue
          const r = el.getBoundingClientRect()
          consider(
            el,
            { left: r.left, top: r.top, width: r.width, height: r.height },
            el.scrollTop, el.scrollLeft, el.scrollHeight, el.clientHeight, el.scrollWidth, el.clientWidth,
          )
        }
        return out
      },
    })
    return (results[0]?.result as Awaited<ReturnType<typeof collectScrollRegions>>) ?? []
  } catch {
    return []
  }
}

// ─── CDP harness ─────────────────────────────────────────────────────────────

const attachedTabs = new Set<number>()
let lastMouse = { x: 0, y: 0 }

async function ensureAttached(tabId: number): Promise<void> {
  if (attachedTabs.has(tabId)) return
  await new Promise<void>((resolve, reject) => {
    chrome.debugger.attach({ tabId }, DEBUGGER_PROTOCOL_VERSION, () => {
      const err = chrome.runtime.lastError
      if (err && !err.message?.includes("Already attached")) {
        reject(new Error(err.message))
        return
      }
      resolve()
    })
  })
  attachedTabs.add(tabId)
}

function sendCDP<R = unknown>(
  tabId: number,
  method: string,
  params?: Record<string, unknown>,
): Promise<R> {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params ?? {}, (result) => {
      const err = chrome.runtime.lastError
      if (err) {
        reject(new Error(`${method}: ${err.message}`))
        return
      }
      resolve(result as R)
    })
  })
}

async function detachAgentDebugger(): Promise<void> {
  for (const tabId of [...attachedTabs]) {
    await new Promise<void>((resolve) => {
      chrome.debugger.detach({ tabId }, () => {
        void chrome.runtime.lastError
        resolve()
      })
    })
  }
  attachedTabs.clear()
  lastMouse = { x: 0, y: 0 }
}

interface KeyInput {
  key: string
  code: string
  keyCode: number
  text?: string
  shift: boolean
}

const NAMED_KEYS = {
  enter:     { key: "Enter",     code: "Enter",     keyCode: 13, text: "\r", shift: false },
  tab:       { key: "Tab",       code: "Tab",       keyCode:  9, shift: false },
  backspace: { key: "Backspace", code: "Backspace", keyCode:  8, shift: false },
} satisfies Record<string, KeyInput>

const SHIFTED_CHAR: Record<string, { code: string; keyCode: number }> = {
  "!": { code: "Digit1", keyCode: 49 },
  "@": { code: "Digit2", keyCode: 50 },
  "#": { code: "Digit3", keyCode: 51 },
  $:   { code: "Digit4", keyCode: 52 },
  "%": { code: "Digit5", keyCode: 53 },
  "^": { code: "Digit6", keyCode: 54 },
  "&": { code: "Digit7", keyCode: 55 },
  "*": { code: "Digit8", keyCode: 56 },
  "(": { code: "Digit9", keyCode: 57 },
  ")": { code: "Digit0", keyCode: 48 },
  _:   { code: "Minus", keyCode: 189 },
  "+": { code: "Equal", keyCode: 187 },
  "{": { code: "BracketLeft", keyCode: 219 },
  "}": { code: "BracketRight", keyCode: 221 },
  "|": { code: "Backslash", keyCode: 220 },
  ":": { code: "Semicolon", keyCode: 186 },
  '"': { code: "Quote", keyCode: 222 },
  "<": { code: "Comma", keyCode: 188 },
  ">": { code: "Period", keyCode: 190 },
  "?": { code: "Slash", keyCode: 191 },
  "~": { code: "Backquote", keyCode: 192 },
}

const UNSHIFTED_CHAR: Record<string, { code: string; keyCode: number }> = {
  "-": { code: "Minus", keyCode: 189 },
  "=": { code: "Equal", keyCode: 187 },
  "[": { code: "BracketLeft", keyCode: 219 },
  "]": { code: "BracketRight", keyCode: 221 },
  "\\": { code: "Backslash", keyCode: 220 },
  ";": { code: "Semicolon", keyCode: 186 },
  "'": { code: "Quote", keyCode: 222 },
  ",": { code: "Comma", keyCode: 188 },
  ".": { code: "Period", keyCode: 190 },
  "/": { code: "Slash", keyCode: 191 },
  "`": { code: "Backquote", keyCode: 192 },
  " ": { code: "Space", keyCode: 32 },
}

function charToKeyInput(char: string): KeyInput {
  if (char >= "a" && char <= "z") {
    return { key: char, code: `Key${char.toUpperCase()}`, keyCode: char.toUpperCase().charCodeAt(0), text: char, shift: false }
  }
  if (char >= "A" && char <= "Z") {
    return { key: char, code: `Key${char}`, keyCode: char.charCodeAt(0), text: char, shift: true }
  }
  if (char >= "0" && char <= "9") {
    return { key: char, code: `Digit${char}`, keyCode: char.charCodeAt(0), text: char, shift: false }
  }
  const shifted = SHIFTED_CHAR[char]
  if (shifted) return { key: char, code: shifted.code, keyCode: shifted.keyCode, text: char, shift: true }
  const unshifted = UNSHIFTED_CHAR[char]
  if (unshifted) return { key: char, code: unshifted.code, keyCode: unshifted.keyCode, text: char, shift: false }
  return { key: char, code: "", keyCode: 0, text: char, shift: false }
}

function parseTypeContent(content: string): string[] {
  const regex = /<enter>|<tab>/g
  const result: string[] = []
  let lastIndex = 0
  content.replace(regex, (match, offset: number) => {
    const text = content.slice(lastIndex, offset).trim()
    if (text) result.push(text)
    result.push(match)
    lastIndex = offset + match.length
    return match
  })
  const remaining = content.slice(lastIndex).trim()
  if (remaining) result.push(remaining)
  return result
}

async function mouse(tabId: number, type: string, x: number, y: number, extra: Record<string, unknown> = {}): Promise<void> {
  await sendCDP(tabId, "Input.dispatchMouseEvent", { type, x, y, ...extra })
}

async function moveMouse(tabId: number, x: number, y: number, steps: number, buttons = 0): Promise<void> {
  const from = lastMouse
  const n = Math.max(1, steps)
  for (let i = 1; i <= n; i++) {
    const ix = from.x + ((x - from.x) * i) / n
    const iy = from.y + ((y - from.y) * i) / n
    await mouse(tabId, "mouseMoved", ix, iy, buttons ? { button: "left", buttons } : {})
  }
  lastMouse = { x, y }
}

async function key(tabId: number, input: KeyInput, type: "keyDown" | "keyUp" | "rawKeyDown", modifiers: number): Promise<void> {
  const params: Record<string, unknown> = {
    type,
    modifiers,
    windowsVirtualKeyCode: input.keyCode,
    code: input.code,
    key: input.key,
  }
  if (type === "keyDown" && input.text) params.text = input.text
  await sendCDP(tabId, "Input.dispatchKeyEvent", params)
}

async function pressChar(tabId: number, char: string): Promise<void> {
  const input = charToKeyInput(char)
  const modifiers = input.shift ? 8 : 0
  await key(tabId, input, "keyDown", modifiers)
  await key(tabId, input, "keyUp", modifiers)
}

async function pressKey(tabId: number, input: KeyInput): Promise<void> {
  await key(tabId, input, "keyDown", 0)
  await key(tabId, input, "keyUp", 0)
}

async function typeContent(tabId: number, content: string): Promise<void> {
  const chunks = parseTypeContent(content)
  let totalTextLength = 0
  for (const chunk of chunks) {
    if (chunk !== "<enter>" && chunk !== "<tab>") totalTextLength += chunk.length
  }
  for (const chunk of chunks) {
    if (chunk === "<enter>") {
      await pressKey(tabId, NAMED_KEYS.enter)
    } else if (chunk === "<tab>") {
      await pressKey(tabId, NAMED_KEYS.tab)
    } else {
      const charDelay =
        totalTextLength > 0
          ? (TOTAL_TYPING_DELAY_MS * (chunk.length / totalTextLength)) / chunk.length
          : 0
      for (const char of chunk) {
        await pressChar(tabId, char)
        if (charDelay > 0) await sleep(charDelay)
      }
    }
  }
}

// A cheap content signature: readyState + element count + text length + a
// coarse hash of visible text. Changes while data streams in and layout shifts;
// stabilizes once the page has settled. Evaluated in-page via CDP.
const DOM_SIGNATURE_EXPR = `(() => {
  const el = document.body ? document.body.getElementsByTagName('*').length : 0;
  const t = document.body ? document.body.innerText : '';
  let h = 0;
  for (let i = 0; i < t.length; i++) { h = (h * 31 + t.charCodeAt(i)) | 0; }
  return document.readyState + ':' + el + ':' + t.length + ':' + h;
})()`

async function domSignature(tabId: number): Promise<string | null> {
  try {
    const r = await sendCDP<{ result: { value: string } }>(tabId, "Runtime.evaluate", {
      expression: DOM_SIGNATURE_EXPR,
      returnByValue: true,
    })
    return r.result.value
  } catch {
    return null
  }
}

// Wait until the page is loaded AND its content has stopped changing. readyState
// alone fires before SPA data lands, so we additionally require the DOM
// signature to hold steady for DOM_IDLE_MS. Bounded by `timeout` so a page that
// never settles (animations, polling widgets) can't hang the loop.
async function waitForStability(tabId: number, timeout = STABILITY_TIMEOUT_MS): Promise<void> {
  const start = Date.now()
  let last: string | null = null
  let steadySince = 0

  while (Date.now() - start < timeout) {
    const sig = await domSignature(tabId)
    const ready = sig ? sig.startsWith("complete") : false

    if (sig !== null && sig === last) {
      if (ready && steadySince && Date.now() - steadySince >= DOM_IDLE_MS) return
    } else {
      steadySince = Date.now() // changed (or first read) — reset the steady clock
    }
    last = sig
    await sleep(DOM_POLL_MS)
  }
}

async function handleAction(taskId: string, actionId: string, action: AgentAction): Promise<void> {
  try {
    if (sessionTabId === null) throw new Error("no session tab")
    const tabId = sessionTabId

    // wait/task:* never reach here — they're handled server-side.
    // browser:nav etc. may run without CDP, but we attach uniformly so the
    // yellow bar is consistent during the run.
    await ensureAttached(tabId)

    switch (action.variant) {
      case "mouse:click": {
        const { x, y } = action
        await moveMouse(tabId, x, y, MOUSE_MOVE_STEPS)
        await mouse(tabId, "mousePressed", x, y, { button: "left", clickCount: 1 })
        await mouse(tabId, "mouseReleased", x, y, { button: "left", clickCount: 1 })
        await waitForStability(tabId)
        break
      }
      case "mouse:double_click": {
        const { x, y } = action
        await moveMouse(tabId, x, y, 1)
        await mouse(tabId, "mousePressed", x, y, { button: "left", clickCount: 1 })
        await mouse(tabId, "mouseReleased", x, y, { button: "left", clickCount: 1 })
        await mouse(tabId, "mousePressed", x, y, { button: "left", clickCount: 2 })
        await mouse(tabId, "mouseReleased", x, y, { button: "left", clickCount: 2 })
        await waitForStability(tabId)
        break
      }
      case "mouse:right_click": {
        const { x, y } = action
        await moveMouse(tabId, x, y, MOUSE_MOVE_STEPS)
        await mouse(tabId, "mousePressed", x, y, { button: "right", clickCount: 1 })
        await mouse(tabId, "mouseReleased", x, y, { button: "right", clickCount: 1 })
        await waitForStability(tabId)
        break
      }
      case "mouse:drag": {
        const { from, to } = action
        await moveMouse(tabId, from.x, from.y, 1)
        await mouse(tabId, "mousePressed", from.x, from.y, { button: "left", clickCount: 1 })
        await sleep(DRAG_HOLD_MS)
        await moveMouse(tabId, to.x, to.y, MOUSE_MOVE_STEPS, 1)
        await mouse(tabId, "mouseReleased", to.x, to.y, { button: "left", clickCount: 1 })
        await waitForStability(tabId)
        break
      }
      case "mouse:scroll": {
        const { x, y, deltaX, deltaY } = action
        await moveMouse(tabId, x, y, 1)
        await mouse(tabId, "mouseWheel", x, y, { deltaX, deltaY })
        await waitForStability(tabId)
        break
      }
      case "keyboard:type": {
        await typeContent(tabId, action.content)
        await waitForStability(tabId)
        break
      }
      case "keyboard:enter": await pressKey(tabId, NAMED_KEYS.enter); break
      case "keyboard:tab": await pressKey(tabId, NAMED_KEYS.tab); break
      case "keyboard:backspace": await pressKey(tabId, NAMED_KEYS.backspace); break
      case "keyboard:select_all": {
        // Ctrl+A (Cmd+A on macOS)
        const modifiers = isMac ? 4 : 2
        const modKey: KeyInput = isMac
          ? { key: "Meta", code: "MetaLeft", keyCode: 91, shift: false }
          : { key: "Control", code: "ControlLeft", keyCode: 17, shift: false }
        const a = charToKeyInput("a")
        await key(tabId, modKey, "rawKeyDown", modifiers)
        await key(tabId, a, "rawKeyDown", modifiers)
        await key(tabId, a, "keyUp", modifiers)
        await key(tabId, modKey, "keyUp", 0)
        break
      }
      case "browser:nav": {
        await chrome.tabs.update(tabId, { url: action.url })
        await waitForStability(tabId)
        break
      }
      case "browser:nav:back": {
        await chrome.tabs.goBack(tabId)
        await waitForStability(tabId)
        break
      }
      case "browser:tab:switch": {
        const active = await chrome.tabs.get(tabId)
        const tabs = await chrome.tabs.query({ windowId: active.windowId })
        const target = tabs.find((t) => t.index === action.index)
        if (!target?.id) throw new Error(`No tab at index ${action.index}`)
        sessionTabId = target.id
        await chrome.tabs.update(target.id, { active: true })
        await ensureAttached(target.id)
        await waitForStability(target.id)
        break
      }
      case "browser:tab:new": {
        const active = await chrome.tabs.get(tabId)
        const tab = await chrome.tabs.create({
          windowId: active.windowId,
          url: "https://www.google.com",
          active: true,
        })
        if (!tab.id) throw new Error("Failed to open new tab")
        sessionTabId = tab.id
        await ensureAttached(tab.id)
        await waitForStability(tab.id)
        break
      }
      case "wait": {
        await sleep(Math.max(0, action.seconds) * 1000)
        break
      }
      default: {
        // task:done / task:fail should never arrive here — they terminate
        // the loop on the server. If one slips through, fail explicitly.
        const variant = (action as { variant: string }).variant
        throw new Error(`Unsupported action variant in extension: ${variant}`)
      }
    }

    sendRaw({ type: "agent_action_result", taskId, actionId, success: true })
  } catch (err: unknown) {
    sendRaw({
      type: "agent_action_result",
      taskId,
      actionId,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

// Auto-detach on tab close / debugger external detach so we don't leak
// attachments across sessions.
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined) attachedTabs.delete(source.tabId)
})

chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId)
  if (tabId === sessionTabId) sessionTabId = null
})

// ─── Content-script relay (unchanged shape, kept for pill/audio) ─────────────

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "compass-relay") return
  port.onMessage.addListener((message: OutboundExtensionMessage) => {
    sendRaw(message)
  })
})

chrome.runtime.onMessage.addListener((message: OutboundExtensionMessage, sender, _sendResponse) => {
  if (message.type === "session_end") {
    sessionTabId = null
    stopVision()
    void detachAgentDebugger()
    broadcastToAllTabs({ type: "pin_pane_clear", sessionId: sessionId || "" })
  } else if (sender.tab?.id !== undefined && sessionTabId === null) {
    sessionTabId = sender.tab.id
  }
  sendRaw(message)
  return false
})

connect()

chrome.runtime.onInstalled.addListener(() => {})
chrome.runtime.onStartup.addListener(() => {})
