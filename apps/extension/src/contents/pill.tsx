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

const player = new PcmPlayer(24000)

const Pill = () => {
  const [listening, setListening]   = useState(false)
  const captureRef = useRef<PcmCapture | null>(null)

  // Incoming audio from Gemini via background → play it
  useEffect(() => {
    const onMessage = (msg: ServerMessage) => {
      if (msg.type !== "audio_chunk") return false
      player.resume()
      player.play(msg.data)
      return false
    }
    chrome.runtime.onMessage.addListener(onMessage)
    return () => chrome.runtime.onMessage.removeListener(onMessage)
  }, [])

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
      </div>
    </div>
  )
}

export default Pill
