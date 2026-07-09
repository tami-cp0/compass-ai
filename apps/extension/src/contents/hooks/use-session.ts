import type { ExtensionMessage, ServerMessage } from "@compass-ai/types"
import { useCallback, useEffect, useRef, useState } from "react"

import { PcmCapture } from "~/audio/pcm-capture"

import { player } from "../lib/audio-runtime"

type StripSessionId<T> = T extends { sessionId: string } ? Omit<T, "sessionId"> : T
type OutboundExtensionMessage = StripSessionId<ExtensionMessage>

export type ConnectionStatus = "ok" | "degraded" | "disconnected"

export interface ResearchTask {
  taskId: string
  name:   string
  status: "started" | "completed" | "failed" | "cancelled"
}

export interface UseSession {
  active:              boolean
  // True when the user wants a session, even if we've torn down capture due
  // to offline. Used by the UI to keep showing the "in-session" layout.
  wantSession:         boolean
  isAutomationRunning: boolean
  researchTasks:       ResearchTask[]
  connectionStatus:    ConnectionStatus
  isOffline:           boolean
  toggle:              () => void
}

// Orchestrates a Compass voice session: PCM capture lifecycle, background
// runtime messaging, and the automation state surfaced through inbound
// ServerMessages.
export function useSession(): UseSession {
  const [active,              setActive]              = useState(false)
  const [isAutomationRunning, setIsAutomationRunning] = useState(false)
  const [researchTasks,       setResearchTasks]       = useState<ResearchTask[]>([])
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
        return false
      }
      // Either an action dispatch or an observation request is enough to
      // know the agent is actively driving the page.
      if (msg.type === "agent_action" || msg.type === "agent_observation_request") {
        setIsAutomationRunning(true)
        return false
      }
      if (msg.type === "automation_end") {
        setIsAutomationRunning(false)
        return false
      }
      if (msg.type === "research_status") {
        setResearchTasks((prev) => {
          if (msg.status === "started") {
            if (prev.some((t) => t.taskId === msg.taskId)) return prev
            return [...prev, { taskId: msg.taskId, name: msg.name, status: "started" }]
          }
          return prev.map((t) => (t.taskId === msg.taskId ? { ...t, status: msg.status } : t))
        })
        // End states just fade out (400ms animation), then drop.
        if (msg.status !== "started") {
          setTimeout(() => {
            setResearchTasks((prev) => prev.filter((t) => t.taskId !== msg.taskId))
          }, 500)
        }
        return false
      }
      if (msg.type === "connection_status") {
        setConnectionStatus(msg.status)
        // Server can't deliver automation_end or research_status through a
        // dead socket, so the UI would otherwise stay stuck on running
        // indicators forever.
        if (msg.status === "disconnected") {
          setIsAutomationRunning(false)
          setResearchTasks([])
        }
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
    player.stop()
    setActive(false)
  }, [])

  const startSession = useCallback(async () => {
    chrome.runtime.sendMessage({ type: "session_start" })
    const capture = new PcmCapture((base64Pcm: string) => {
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
    setResearchTasks([])
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

  return { active, wantSession, isAutomationRunning, researchTasks, connectionStatus, isOffline, toggle }
}
