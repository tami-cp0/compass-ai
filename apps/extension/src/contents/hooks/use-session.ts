import type { ExtensionMessage, ServerMessage } from "@compass-ai/types"
import { useCallback, useEffect, useRef, useState } from "react"

import { PcmCapture } from "~/audio/pcm-capture"

import { player } from "../lib/audio-runtime"

type StripSessionId<T> = T extends { sessionId: string } ? Omit<T, "sessionId"> : T
type OutboundExtensionMessage = StripSessionId<ExtensionMessage>

export interface PendingConfirmation {
  actionId:    string
  taskId:      string
  description: string
}

export type ConnectionStatus = "ok" | "degraded" | "disconnected"

export interface UseSession {
  active:              boolean
  // True when the user wants a session, even if we've torn down capture due
  // to offline. Used by the UI to keep showing the "in-session" layout.
  wantSession:         boolean
  isSpeaking:          boolean
  isAutomationRunning: boolean
  confirmation:        PendingConfirmation | null
  connectionStatus:    ConnectionStatus
  isOffline:           boolean
  toggle:              () => void
}

// Orchestrates a Compass voice session: PCM capture lifecycle, background
// runtime messaging, and the speaking / automation / confirmation state
// surfaced through inbound ServerMessages.
export function useSession(): UseSession {
  const [active,              setActive]              = useState(false)
  const [isSpeaking,          setIsSpeaking]          = useState(false)
  const [isAutomationRunning, setIsAutomationRunning] = useState(false)
  const [confirmation,        setConfirmation]        = useState<PendingConfirmation | null>(null)
  const [connectionStatus,    setConnectionStatus]    = useState<ConnectionStatus>("ok")
  const [isOffline,           setIsOffline]           = useState(typeof navigator !== "undefined" && !navigator.onLine)
  const [wantSession,         setWantSession]         = useState(false)
  const captureRef = useRef<PcmCapture | null>(null)

  useEffect(() => {
    const onOnline  = () => setIsOffline(false)
    const onOffline = () => setIsOffline(true)
    window.addEventListener("online",  onOnline)
    window.addEventListener("offline", onOffline)
    return () => {
      window.removeEventListener("online",  onOnline)
      window.removeEventListener("offline", onOffline)
    }
  }, [])

  useEffect(() => {
    const onMessage = (msg: ServerMessage) => {
      if (msg.type === "audio_chunk") {
        player.resume()
        player.play(msg.data)
        setIsSpeaking(true)
        return false
      }
      if (msg.type === "action") {
        setIsAutomationRunning(true)
        return false
      }
      if (msg.type === "user_action_required") {
        setConfirmation({ actionId: msg.actionId, taskId: msg.taskId, description: msg.description })
        return false
      }
      if (msg.type === "automation_end") {
        setIsAutomationRunning(false)
        setConfirmation(null)
        return false
      }
      if (msg.type === "connection_status") {
        setConnectionStatus(msg.status)
        return false
      }
      return false
    }
    chrome.runtime.onMessage.addListener(onMessage)
    return () => chrome.runtime.onMessage.removeListener(onMessage)
  }, [])

  // Internal: stop mic capture only. Does NOT send session_end — the server
  // keeps the Gemini resumption handle alive so we can resume on reconnect.
  const teardownCapture = useCallback(() => {
    captureRef.current?.stop()
    captureRef.current = null
    setActive(false)
    setIsSpeaking(false)
  }, [])

  const startSession = useCallback(async () => {
    chrome.runtime.sendMessage({ type: "session_start" })
    const capture = new PcmCapture((base64Pcm: string) => {
      setIsSpeaking(false)
      chrome.runtime.sendMessage({
        type:     "audio_chunk",
        data:     base64Pcm,
        mimeType: "audio/pcm"
      } as OutboundExtensionMessage)
    })
    await capture.start()
    captureRef.current = capture
    setActive(true)
  }, [])

  // Explicit user stop: tear down mic AND tell the server, which closes the
  // Gemini session and deletes the resumption handle.
  const stopSession = useCallback(() => {
    setWantSession(false)
    chrome.runtime.sendMessage({ type: "session_end" })
    teardownCapture()
  }, [teardownCapture])

  const toggle = useCallback(() => {
    if (wantSession) {
      stopSession()
    } else {
      setWantSession(true)
      startSession().catch(console.error)
    }
  }, [wantSession, startSession, stopSession])

  // Auto-stop on offline; auto-resume on online only if we paused it ourselves.
  const pausedByOfflineRef = useRef(false)
  useEffect(() => {
    if (isOffline) {
      if (captureRef.current) {
        pausedByOfflineRef.current = true
        teardownCapture()
      }
      return
    }
    if (wantSession && !captureRef.current && pausedByOfflineRef.current) {
      pausedByOfflineRef.current = false
      startSession().catch(console.error)
    }
  }, [isOffline, wantSession, teardownCapture, startSession])

  return { active, wantSession, isSpeaking, isAutomationRunning, confirmation, connectionStatus, isOffline, toggle }
}
