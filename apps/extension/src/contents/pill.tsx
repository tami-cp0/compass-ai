import type { ExtensionMessage, ServerMessage } from "@compass-ai/types"
import cssText from "data-text:~/styles/globals.css"
import { MicIcon, MicOff } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"

import { PcmCapture } from "~/audio/pcm-capture"
import { PcmPlayer } from "~/audio/pcm-player"

type StripSessionId<T> = T extends { sessionId: string } ? Omit<T, "sessionId"> : T
type OutboundExtensionMessage = StripSessionId<ExtensionMessage>

export const getStyle = () => {
  const style = document.createElement("style")
  style.textContent = cssText
  return style
}

interface PendingConfirmation {
  actionId:    string
  taskId:      string
  description: string
}

const player = new PcmPlayer(24000)

const Pill = () => {
  const [listening, setListening]       = useState(false)
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(null)
  const captureRef = useRef<PcmCapture | null>(null)

  useEffect(() => {
    const onMessage = (msg: ServerMessage) => {
      if (msg.type === "audio_chunk") {
        player.resume()
        player.play(msg.data)
        return false
      }
      if (msg.type === "user_action_required") {
        setConfirmation({
          actionId:    msg.actionId,
          taskId:      msg.taskId,
          description: msg.description,
        })
        return false
      }
      if (msg.type === "automation_end") {
        setConfirmation(null)
        return false
      }
      return false
    }
    chrome.runtime.onMessage.addListener(onMessage)
    return () => chrome.runtime.onMessage.removeListener(onMessage)
  }, [])

  const sendConfirmation = useCallback((confirmed: boolean) => {
    if (!confirmation) return
    const reply: OutboundExtensionMessage = {
      type:     "user_action_result",
      actionId: confirmation.actionId,
      taskId:   confirmation.taskId,
      confirmed,
    }
    chrome.runtime.sendMessage(reply, () => {
      if (chrome.runtime.lastError) {
        console.error("[compass] user_action_result send failed:", chrome.runtime.lastError.message)
        return
      }
      setConfirmation(null)
    })
  }, [confirmation])

  const startListening = useCallback(async () => {
    const capture = new PcmCapture((base64Pcm: string) => {
      const msg: OutboundExtensionMessage = {
        type:     "audio_chunk",
        data:     base64Pcm,
        mimeType: "audio/pcm",
      }
      chrome.runtime.sendMessage(msg)
    })
    await capture.start()
    captureRef.current = capture
    setListening(true)
  }, [])

  const stopListening = useCallback(() => {
    captureRef.current?.stop()
    captureRef.current = null
    setListening(false)
  }, [])

  const toggle = useCallback(() => {
    if (listening) {
      stopListening()
    } else {
      startListening().catch(console.error)
    }
  }, [listening, startListening, stopListening])

  return (
    <div className="fixed top-6 flex justify-center w-full">
      <div
        className="relative w-fit h-fit bg-white/60 backdrop-blur-xl border border-white/30 rounded-2xl shadow-2xl cursor-default pointer-events-auto
          before:absolute before:inset-0 before:rounded-2xl before:pointer-events-none
          before:bg-gradient-to-br before:from-white/20 before:to-transparent
          after:absolute after:inset-0 after:rounded-2xl after:pointer-events-none
          after:bg-gradient-to-tl after:from-black/10 after:to-transparent">
        <div className="flex gap-2 justify-center items-center rounded-full">
          <span className="inline-flex items-center justify-center relative z-10 h-8 px-2 leading-none">
            compass
          </span>
          <button
            onClick={toggle}
            className="relative z-10 border p-1 rounded-full focus:outline-none"
            aria-label={listening ? "Stop listening" : "Start listening"}>
            {listening ? (
              <MicIcon size={16} className="text-red-500 animate-pulse" />
            ) : (
              <MicOff size={16} className="text-gray-400" />
            )}
          </button>
        </div>

        {confirmation && (
          <div className="relative z-10 border-t border-white/30 px-3 py-2 flex flex-col gap-2 max-w-xs">
            <p className="text-xs text-gray-800 leading-snug">{confirmation.description}</p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => sendConfirmation(false)}
                className="text-xs px-2 py-1 rounded border border-gray-300 bg-white/80 hover:bg-white">
                Cancel
              </button>
              <button
                onClick={() => sendConfirmation(true)}
                className="text-xs px-2 py-1 rounded border border-blue-400 bg-blue-500 text-white hover:bg-blue-600">
                Confirm
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default Pill
