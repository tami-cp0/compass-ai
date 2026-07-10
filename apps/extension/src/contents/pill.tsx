import cssText from "data-text:~/styles/globals.css"
import type { PlasmoCSConfig } from "plasmo"
import { useEffect, useRef, useState } from "react"

import { CompassIcon } from "./components/compass-icon"
import { FrequencyBars } from "./components/frequency-bars"
import { ReconnectingIcon } from "./components/reconnecting-icon"
import { ResearchChips } from "./components/research-chips"
import { VisionChip } from "./components/vision-chip"
import { useSession } from "./hooks/use-session"
import { createEdgeGlow, type EdgeGlowHandle } from "./lib/edge-glow"
import { derivePillView } from "./lib/pill-view"

export const config: PlasmoCSConfig = {
  matches: ["https://app.atlassportfolios.com/*"]
}

export const getStyle = () => {
  const style = document.createElement("style")
  style.textContent = cssText
  return style
}

const SLOW_TO_RECONNECTING_MS = 5_000
const OFFLINE_FLASH_MS        = 5_000

const Pill = () => {
  const { active, wantSession, isAutomationRunning, researchTasks, isVisionOn, connectionStatus, isOffline, toggle } = useSession()
  const [showActive, setShowActive] = useState(false)
  const [degradedAged, setDegradedAged] = useState(false)
  const [offlineFlash, setOfflineFlash] = useState(false)
  const glowRef = useRef<EdgeGlowHandle | null>(null)

  useEffect(() => {
    glowRef.current = createEdgeGlow()
    return () => {
      glowRef.current?.destroy()
      glowRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!wantSession) setShowActive(false)
  }, [wantSession])

  useEffect(() => {
    glowRef.current?.setActive(isAutomationRunning)
  }, [isAutomationRunning])

  // "slow network" upgrades to "reconnecting" after 5s of continuous degraded.
  useEffect(() => {
    if (connectionStatus !== "degraded") {
      setDegradedAged(false)
      return
    }
    const id = setTimeout(() => setDegradedAged(true), SLOW_TO_RECONNECTING_MS)
    return () => clearTimeout(id)
  }, [connectionStatus])

  // Clear the offline flash early if the network comes back during it.
  useEffect(() => {
    if (!isOffline && offlineFlash) setOfflineFlash(false)
  }, [isOffline, offlineFlash])

  const view = derivePillView({
    active, wantSession, isOffline, offlineFlash, showActive, degradedAged, connectionStatus,
  })

  const handleClick = () => {
    if (view.pillState === "offline") return  // already flashing or persistently offline; no-op
    if (!wantSession && isOffline) {
      setOfflineFlash(true)
      setTimeout(() => setOfflineFlash(false), OFFLINE_FLASH_MS)
      return
    }
    toggle()
  }

  const classes = [
    "button relative flex items-center justify-center h-10 px-4 py-1 cursor-pointer bg-transparent rounded-full overflow-hidden origin-center transition-[width] duration-300 ease-in-out",
    view.widthClass,
    view.tintClass,
  ].filter(Boolean).join(" ")

  return (
    <div className="fixed top-6 left-1/2 -translate-x-1/2">
      <button
        className={classes}
        onClick={handleClick}
        onTransitionEnd={(e) => {
          if (e.propertyName === "width" && wantSession) setShowActive(true)
        }}
        aria-label={wantSession ? "Stop session" : "Start session"}
      >
        {view.showBarsLayout ? (
          <div className="flex items-center gap-2 fade-in">
            {view.isReconnecting ? (
              <ReconnectingIcon className="size-6 spin-slow" />
            ) : (
              <FrequencyBars mode={view.barsMode} />
            )}
            <span
              className={`relative z-10 text-sm whitespace-nowrap ${view.isReconnecting ? "text_button text_button_fast" : "text-white/90"}`}
              style={{ transform: "translateY(-1px)" }}
            >
              {view.activeLabel}
            </span>
          </div>
        ) : (
          <div className="flex items-center">
            <div className="h-10 w-7 shrink-0" />
            <CompassIcon className="size-10 absolute left-0 z-10" />
            <span className="text_button relative z-10 whitespace-nowrap">
              {view.pillState === "offline" ? "you are offline" : "Compass"}
            </span>
          </div>
        )}
      </button>
      <VisionChip on={isVisionOn} />
      <ResearchChips tasks={researchTasks} />
    </div>
  )
}

export default Pill
