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

// Screenshots ship at native CSS-pixel resolution (captureVisibleTab returns
// physical pixels; we resample by 1/dpr exactly once). No further cap — model
// coords are then 1:1 with what CDP dispatches. Gemini Live (flat 258 tokens
// at high-res) and GPT-5.4 Mini (saturates at 6 tiles for any 16:9 viewport)
// both prefer this; resolution doesn't move the needle on cost.

const DEBUGGER_PROTOCOL_VERSION = "1.3"

// CDP timing — kept identical to pear's tested values
const STABILITY_TIMEOUT_MS = 5000
const SETTLE_MS = 300
const TOTAL_TYPING_DELAY_MS = 500
const MOUSE_MOVE_STEPS = 20
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
// The tab that owns the active session. Captured from sender.tab on
// session_start. chrome.tabs.query({active, currentWindow}) is unreliable
// from a service worker — focus may be on DevTools or another window when
// a server message arrives, dropping relays silently.
let sessionTabId: number | null = null
let attempt = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let bufferPollTimer: ReturnType<typeof setInterval> | null = null
let connectionStatus: ConnectionStatus = "ok"
let highSince: number | null = null
let lowSince:  number | null = null

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

    relayToSessionTab(msg)
  }

  ws.onclose = () => {
    ws = null
    stopBufferWatch()
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
  base64: string  // raw base64 PNG (no data: prefix)
  width: number   // CSS-pixel width (= viewport width)
  height: number  // CSS-pixel height (= viewport height)
}

async function captureFromTab(tabId: number): Promise<CapturedFrame> {
  const tab = await chrome.tabs.get(tabId)
  // PNG: lossless capture. JPEG would discard high-frequency detail (text,
  // edges) before we ever look at the bitmap.
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: "png",
  })
  if (!dataUrl) throw new Error("captureVisibleTab returned empty")

  // viewport = physical pixels / dpr (CSS pixels)
  const [, vw, vh] = await readViewport(tabId)

  // Source bitmap is at physical pixels (vw × dpr, vh × dpr).
  const sourceBlob = await (await fetch(dataUrl)).blob()
  const sourceBitmap = await createImageBitmap(sourceBlob)

  // Output at CSS-pixel size (vw × vh). No cap. Coords the model emits map
  // 1:1 to viewport CSS pixels, which is what CDP expects.
  const canvas = new OffscreenCanvas(vw, vh)
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("Failed to acquire 2D canvas context")
  // Smoothing on (bilinear/bicubic) — better for non-integer dpr downscales
  // (e.g. dpr=1.5) than nearest-neighbor. On dpr=1 (no scale) and dpr=2
  // (integer scale) the setting is effectively a no-op.
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = "high"
  ctx.drawImage(sourceBitmap, 0, 0, vw, vh)

  const outBlob = await canvas.convertToBlob({ type: "image/png" })
  const base64 = await blobToBase64(outBlob)

  return { base64, width: vw, height: vh }
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

// Used by the Gemini Live screenshot tool. Mirrors the existing behavior the
// content script used to provide. Returns a raw base64 PNG of the active tab.
async function handleGeminiScreenshotRequest(requestId: string): Promise<void> {
  try {
    if (sessionTabId === null) {
      sendRaw({ type: "screenshot_response", requestId, dataUrl: "" })
      return
    }
    const frame = await captureFromTab(sessionTabId)
    sendRaw({ type: "screenshot_response", requestId, dataUrl: frame.base64 })
  } catch (err) {
    console.error("[compass] gemini screenshot failed:", err)
    sendRaw({ type: "screenshot_response", requestId, dataUrl: "" })
  }
}

// ─── Agent observation ───────────────────────────────────────────────────────

async function handleObservationRequest(taskId: string): Promise<void> {
  try {
    if (sessionTabId === null) throw new Error("no session tab")
    const tab = await chrome.tabs.get(sessionTabId)
    const frame = await captureFromTab(sessionTabId)

    sendRaw({
      type: "agent_observation",
      taskId,
      screenshot: frame.base64,
      width: frame.width,
      height: frame.height,
      url: tab.url ?? "",
      title: tab.title ?? "",
    })
  } catch (err) {
    console.error("[compass] observation failed:", err)
    sendRaw({
      type: "agent_observation",
      taskId,
      screenshot: "",
      width: 0,
      height: 0,
      url: "",
      title: "",
    })
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

async function waitForStability(tabId: number, timeout = STABILITY_TIMEOUT_MS): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    let ready: string | undefined
    try {
      const r = await sendCDP<{ result: { value: string } }>(tabId, "Runtime.evaluate", {
        expression: "document.readyState",
        returnByValue: true,
      })
      ready = r.result.value
    } catch {
      ready = undefined
    }
    if (ready === "complete") break
    await sleep(100)
  }
  await sleep(SETTLE_MS)
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

// ─── Dev console helpers ─────────────────────────────────────────────────────
// Exposed on globalThis so they're callable from the service-worker devtools
// console (chrome://extensions → "service worker" link). Stripped from
// production builds — server also ignores the debug message when NODE_ENV is
// "production".
if (process.env.NODE_ENV !== "production") {
  type DebugDispatch = (description: string, name?: string) => void
  type DebugCancel   = (name: string) => void

  const runWebAgent: DebugDispatch = (description, name) => {
    if (!sessionId) {
      console.warn(
        "[compass] __runWebAgent: no active session. Click the pill to start one first.",
      )
      return
    }
    if (typeof description !== "string" || description.trim().length === 0) {
      console.warn(
        '[compass] __runWebAgent: usage __runWebAgent("describe the task", "optional-name")',
      )
      return
    }
    const taskName = name ?? `console-task-${Date.now()}`
    sendRaw({ type: "agent_dispatch_debug", name: taskName, description })
    console.log(
      `[compass] __runWebAgent → dispatched name="${taskName}" description="${description.slice(0, 80)}"`,
    )
  }

  const cancelWebAgent: DebugCancel = (name) => {
    if (!sessionId) {
      console.warn("[compass] __cancelWebAgent: no active session.")
      return
    }
    if (typeof name !== "string" || name.length === 0) {
      console.warn('[compass] __cancelWebAgent: usage __cancelWebAgent("task-name")')
      return
    }
    sendRaw({ type: "agent_cancel_debug", name })
    console.log(`[compass] __cancelWebAgent → dispatched name="${name}"`)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).__runWebAgent = runWebAgent
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).__cancelWebAgent = cancelWebAgent

  console.log(
    "[compass] DEV: __runWebAgent(description, name?) and __cancelWebAgent(name) are available in this console",
  )
}
