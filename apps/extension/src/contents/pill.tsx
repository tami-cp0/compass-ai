import cssText from "data-text:~/styles/globals.css"
import type { PlasmoCSConfig } from "plasmo"
import { useEffect, useRef, useState } from "react"

import { CompassIcon } from "./components/compass-icon"
import { FrequencyBars } from "./components/frequency-bars"
import { useSession } from "./hooks/use-session"
import { createEdgeGlow, type EdgeGlowHandle } from "./lib/edge-glow"

export const config: PlasmoCSConfig = {
  matches: ["https://app.atlassportfolios.com/*"]
}

export const getStyle = () => {
  const style = document.createElement("style")
  style.textContent = cssText
  return style
}

const Pill = () => {
  const { active, isSpeaking, isAutomationRunning, toggle } = useSession()
  const [showActive, setShowActive] = useState(false)
  const glowRef = useRef<EdgeGlowHandle | null>(null)

  useEffect(() => {
    glowRef.current = createEdgeGlow()
    return () => {
      glowRef.current?.destroy()
      glowRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!active) setShowActive(false)
  }, [active])

  useEffect(() => {
    glowRef.current?.setActive(isAutomationRunning)
  }, [isAutomationRunning])

  return (
    <div className="fixed top-6 left-1/2 -translate-x-1/2">
      <button
        className={`button relative flex items-center justify-center h-10 px-4 py-1 cursor-pointer bg-transparent rounded-full overflow-hidden origin-center transition-[width] duration-300 ease-in-out ${active ? "active w-[170px]" : "w-[130px]"}`}
        onClick={toggle}
        onTransitionEnd={(e) => {
          if (e.propertyName === "width" && active) setShowActive(true)
        }}
        aria-label={active ? "Stop session" : "Start session"}
      >
        {showActive ? (
          <div className="flex items-center gap-2 fade-in">
            <FrequencyBars mode={active ? (isSpeaking ? "speaker" : "mic") : "idle"} />
            <span className="relative z-10 text-white/90 text-sm whitespace-nowrap">
              {isSpeaking ? "speaking" : "listening"}
            </span>
          </div>
        ) : !active ? (
          <div className="flex items-center">
            <div className="h-10 w-7 shrink-0" />
            <CompassIcon className="size-10 absolute left-0 z-10" />
            <span className="text_button relative z-10 whitespace-nowrap">Compass</span>
          </div>
        ) : null}
      </button>
    </div>
  )
}

export default Pill
