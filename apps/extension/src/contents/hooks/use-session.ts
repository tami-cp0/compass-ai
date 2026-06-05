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

export interface UseSession {
  active:              boolean
  isSpeaking:          boolean
  isAutomationRunning: boolean
  confirmation:        PendingConfirmation | null
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
  const captureRef = useRef<PcmCapture | null>(null)

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
      return false
    }
    chrome.runtime.onMessage.addListener(onMessage)
    return () => chrome.runtime.onMessage.removeListener(onMessage)
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

  const stopSession = useCallback(() => {
    captureRef.current?.stop()
    captureRef.current = null
    chrome.runtime.sendMessage({ type: "session_end" })
    setActive(false)
    setIsSpeaking(false)
  }, [])

  const toggle = useCallback(() => {
    if (active) stopSession()
    else        startSession().catch(console.error)
  }, [active, startSession, stopSession])

  return { active, isSpeaking, isAutomationRunning, confirmation, toggle }
}
