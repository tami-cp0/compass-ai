import type { ExtensionMessage, ServerMessage } from "@compass-ai/types"
import cssText from "data-text:~/styles/globals.css"
import { MicIcon, MicOff } from "lucide-react"
import { useCallback, useEffect, useState } from "react"

import { WebSpeechProvider } from "~/speech/web-speech-provider"

type StripSessionId<T> = T extends { sessionId: string }
  ? Omit<T, "sessionId">
  : T
type OutboundExtensionMessage = StripSessionId<ExtensionMessage>

export const getStyle = () => {
  const style = document.createElement("style")
  style.textContent = cssText
  return style
}

const provider = new WebSpeechProvider()
let audioCtx: AudioContext | null = null

function getAudioCtx(): AudioContext {
  if (!audioCtx) audioCtx = new AudioContext()
  return audioCtx
}

async function playAudio(base64Data: string): Promise<void> {
  const ctx = getAudioCtx()
  const bytes = Uint8Array.from(atob(base64Data), (c) => c.charCodeAt(0))
  const audioBuffer = await ctx.decodeAudioData(bytes.buffer.slice(0))
  const source = ctx.createBufferSource()
  source.buffer = audioBuffer
  source.connect(ctx.destination)
  source.start()
}

const Pill = () => {
  const [listening, setListening] = useState(false)

  useEffect(() => {
    provider.onTranscript = (text: string, isFinal: boolean) => {
      const msg: OutboundExtensionMessage = {
        type: "transcript_input",
        text,
        isFinal
      }
      chrome.runtime.sendMessage(msg)
    }
    return () => {
      provider.onTranscript = null
    }
  }, [])

  useEffect(() => {
    const onMessage = (msg: ServerMessage) => {
      if (msg.type !== "speech_audio") return
      const ctx = getAudioCtx()
      if (ctx.state === "suspended") {
        ctx
          .resume()
          .then(() => playAudio(msg.data))
          .catch(console.error)
      } else {
        playAudio(msg.data).catch(console.error)
      }
    }
    chrome.runtime.onMessage.addListener(onMessage)
    return () => {
      chrome.runtime.onMessage.removeListener(onMessage)
    }
  }, [])

  const toggle = useCallback(() => {
    if (listening) {
      provider.stop()
      setListening(false)
    } else {
      if (!WebSpeechProvider.isSupported()) {
        console.warn("[compass] Web Speech API not supported in this browser")
        return
      }
      // Initialize AudioContext inside user gesture so it starts in running state
      getAudioCtx()
      provider.start()
      setListening(true)
    }
  }, [listening])

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
