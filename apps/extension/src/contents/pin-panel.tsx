import cssText from "data-text:~/styles/globals.css"
import { FoldHorizontal, UnfoldHorizontal } from "lucide-react"
import type { PlasmoCSConfig } from "plasmo"
import { useState } from "react"

export const config: PlasmoCSConfig = {
  matches: ["<all_urls>"]
}

export const getStyle = () => {
  const style = document.createElement("style")
  style.textContent = cssText
  return style
}

type PanelStage = "collapsed" | "expanding-width" | "expanding-height" | "open"

const PinPanel = () => {
  const [stage, setStage] = useState<PanelStage>("open")

  const handleRootClick = () => {
    if (stage === "collapsed") setStage("expanding-width")
  }

  const handleCollapseClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (stage === "open") setStage("collapsed")
  }

  const handleTransitionEnd = (e: React.TransitionEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return
    if (stage === "expanding-width" && e.propertyName === "width") {
      setStage("expanding-height")
    } else if (stage === "expanding-height" && e.propertyName === "height") {
      setStage("open")
    }
  }

  const isCollapsedVisual = stage === "collapsed"
  const stageClass =
    stage === "collapsed"
      ? "collapsed"
      : stage === "expanding-width"
        ? "expanding-width"
        : stage === "expanding-height"
          ? "expanding-height"
          : ""

  return (
    <div
      className={`pin-panel ${stageClass}`}
      style={{ zIndex: 2147483646 }}
      onClick={handleRootClick}
      onTransitionEnd={handleTransitionEnd}
      aria-label="Pinned items"
    >
      <div
        className="pin-panel__collapse"
        onClick={stage === "open" ? handleCollapseClick : undefined}
        role="button"
        aria-label={isCollapsedVisual ? "Expand pin panel" : "Collapse pin panel"}
      >
        {isCollapsedVisual ? (
          <UnfoldHorizontal size={18} style={{ transform: "rotate(-45deg)" }} />
        ) : (
          <FoldHorizontal size={18} style={{ transform: "rotate(-45deg)" }} />
        )}
      </div>
    </div>
  )
}

export default PinPanel
