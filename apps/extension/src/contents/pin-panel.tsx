import type { ServerMessage } from "@compass-ai/types"
import globalsCss from "data-text:~/styles/globals.css"
import pinPanelCss from "data-text:~/styles/pin-panel.css"
import { FoldHorizontal, UnfoldHorizontal } from "lucide-react"
import type { PlasmoCSConfig } from "plasmo"
import { Component, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

export const config: PlasmoCSConfig = {
  matches: ["https://app.atlassportfolios.com/*"]
}

export const getStyle = () => {
  const style = document.createElement("style")
  style.textContent = `${globalsCss}\n${pinPanelCss}`
  return style
}

type PanelStage =
  | "collapsed"
  | "expanding-width"
  | "expanding-height"
  | "open"
  | "collapsing-to-clear"
  | "collapsing-to-swap"

interface PaneContent {
  title:    string
  markdown: string
  width:    number
  height:   number
}

// Pane is fixed top-right with a 24px margin. The pill is centered horizontally
// at top-6. To prevent the pane from overlapping the pill, its left edge must
// stay at least PILL_GAP px to the right of the pill's right edge. We don't
// have a reliable handle to the pill from this content script (separate shadow
// root), so assume the largest known pill width.
const PANE_RIGHT_MARGIN = 24
const PILL_GAP           = 24
const MAX_PILL_WIDTH     = 200
const MAX_WIDTH          = 500
const clampWidth = (requested: number): number => {
  const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1280
  const pillRightEdge = viewportWidth / 2 + MAX_PILL_WIDTH / 2
  const maxByViewport = Math.floor(viewportWidth - PANE_RIGHT_MARGIN - PILL_GAP - pillRightEdge)
  return Math.max(220, Math.min(MAX_WIDTH, maxByViewport, Math.round(requested)))
}

// Mirrors the CSS in pin-panel.css. Header is fixed-height; body has 12px
// bottom padding only (header's 8px bottom acts as the body's top padding).
const HEADER_HEIGHT  = 38
const BODY_PAD_TOTAL = 12
const HEIGHT_SAFETY  = 8
// Hard ceiling so a runaway markdown blob can't grow the pane past the viewport.
const MAX_HEIGHT     = 720
const clampHeight = (requested: number): number => {
  const viewportHeight = typeof window !== "undefined" ? window.innerHeight : 800
  const maxByViewport  = Math.floor(viewportHeight - 2 * PANE_RIGHT_MARGIN)
  return Math.max(120, Math.min(MAX_HEIGHT, maxByViewport, Math.round(requested)))
}

// The header renders the title; the model sometimes still emits a leading
// heading or bold line that restates the title (or a near-paraphrase like
// "Welcome!" when title is "Quick Welcome"). Strip it so we never show two.
const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "")
const stripDuplicateTitleHeading = (title: string, markdown: string): string => {
  const lines = markdown.split("\n")
  let i = 0
  while (i < lines.length && lines[i].trim() === "") i++
  if (i >= lines.length) return markdown
  const first = lines[i].trim()
  const headingMatch  = first.match(/^#{1,6}\s+(.+?)\s*#*\s*$/)
  const boldOnlyMatch = first.match(/^\*\*(.+?)\*\*[!.?:]*$/)
  const text = headingMatch?.[1] ?? boldOnlyMatch?.[1]
  if (!text) return markdown
  const a = normalize(text)
  const b = normalize(title)
  const isDup = a === b || a.includes(b) || b.includes(a)
  if (!isDup) return markdown
  let j = i + 1
  while (j < lines.length && lines[j].trim() === "") j++
  return lines.slice(j).join("\n")
}

// react-markdown 8 + remark-gfm 3 crash on some inputs (notably tables with
// stray whitespace nodes — "Cannot convert undefined or null to object" in
// addProperty). Catch the failure here so the pane falls back to a plain
// rendering instead of blanking the whole panel.
class MarkdownErrorBoundary extends Component<
  { markdown: string; children: ReactNode },
  { errored: boolean }
> {
  state = { errored: false }
  static getDerivedStateFromError() {
    return { errored: true }
  }
  componentDidUpdate(prev: { markdown: string }) {
    if (prev.markdown !== this.props.markdown && this.state.errored) {
      this.setState({ errored: false })
    }
  }
  render() {
    if (this.state.errored) {
      return <pre className="pp-pre" style={{ whiteSpace: "pre-wrap" }}>{this.props.markdown}</pre>
    }
    return this.props.children
  }
}

// Normalize markdown before passing to react-markdown 8 / remark-gfm 3, which
// crash on a handful of input patterns (most often inside GFM tables). This
// pre-pass targets the specific shapes that have caused boundary fallbacks:
//   1. CRLF/CR line endings (parser quirks at boundaries)
//   2. BOM and zero-width characters that produce empty AST text nodes
//   3. Trailing whitespace on table rows
//   4. Separator rows whose column count doesn't match the header row
//   5. Tab characters inside cells (treated inconsistently)
const sanitizeMarkdown = (raw: string): string => {
  // 1) line endings
  let s = raw.replace(/\r\n?/g, "\n")
  // 2) strip BOM + zero-width chars
  s = s.replace(/[﻿​‌‍⁠]/g, "")
  // Per-line cleanup
  const lines = s.split("\n").map((line) => {
    // Tabs → spaces inside table rows (and generally — react-markdown handles
    // them but remark-gfm's table builder has been observed to choke).
    if (line.includes("|")) line = line.replace(/\t/g, "    ")
    // Trim trailing whitespace (the most common table crash trigger).
    return line.replace(/[ \t]+$/, "")
  })
  // 3) Table-aware fixup. Walk in groups of consecutive `|`-containing lines.
  const SEP_CELL = /^\s*:?-{1,}:?\s*$/
  const splitRow = (row: string): string[] => {
    // Drop one leading/trailing pipe if present, then split on unescaped pipes.
    let r = row.trim()
    if (r.startsWith("|")) r = r.slice(1)
    if (r.endsWith("|")) r = r.slice(0, -1)
    return r.split(/(?<!\\)\|/)
  }
  for (let i = 0; i < lines.length - 1; i++) {
    const header = lines[i]
    const sep    = lines[i + 1]
    if (!header.includes("|") || !sep.includes("|")) continue
    const sepCells = splitRow(sep).map((c) => c.trim())
    if (sepCells.length === 0 || !sepCells.every((c) => SEP_CELL.test(c))) continue
    // Unconditionally rebuild the separator row to plain `---` cells matching
    // the header's column count. This serves two purposes:
    //   - Strips alignment markers (`:---`, `---:`, `:---:`) which crash
    //     react-markdown 8 + remark-gfm 3 in addProperty.
    //   - Repairs mismatched column counts between header and separator.
    const headerCells = splitRow(header)
    const repaired = headerCells.map(() => "---").join(" | ")
    lines[i + 1] = `| ${repaired} |`
  }
  return lines.join("\n")
}

const MarkdownBody = ({ markdown }: { markdown: string }) => (
  <ReactMarkdown
    remarkPlugins={[remarkGfm]}
    components={{
      p:          ({ node, ...props }) => <p className="pp-p" {...props} />,
      ul:         ({ node, ...props }) => <ul className="pp-ul" {...props} />,
      ol:         ({ node, ...props }) => <ol className="pp-ol" {...props} />,
      li:         ({ node, ...props }) => <li className="pp-li" {...props} />,
      h1:         ({ node, ...props }) => <h3 className="pp-h" {...props} />,
      h2:         ({ node, ...props }) => <h3 className="pp-h" {...props} />,
      h3:         ({ node, ...props }) => <h3 className="pp-h" {...props} />,
      h4:         ({ node, ...props }) => <h4 className="pp-h" {...props} />,
      code:       ({ node, ...props }) => <code className="pp-code" {...props} />,
      pre:        ({ node, ...props }) => <pre className="pp-pre" {...props} />,
      table:      ({ node, ...props }) => <table className="pp-table" {...props} />,
      strong:     ({ node, ...props }) => <strong className="pp-strong" {...props} />,
      em:         ({ node, ...props }) => <em className="pp-em" {...props} />,
      del:        ({ node, ...props }) => <del className="pp-del" {...props} />,
      blockquote: ({ node, ...props }) => <blockquote className="pp-blockquote" {...props} />,
      hr:         ({ node, ...props }) => <hr className="pp-hr" {...props} />,
      a:          ({ node, ...props }) => <a className="pp-a" target="_blank" rel="noreferrer" {...props} />,
    } as never}>
    {sanitizeMarkdown(markdown)}
  </ReactMarkdown>
)

const PinPanel = () => {
  const [content, setContent] = useState<PaneContent | null>(null)
  const [stage, setStage]     = useState<PanelStage>("collapsed")
  const [measuredHeight, setMeasuredHeight] = useState<number | null>(null)
  const pendingContentRef = useRef<PaneContent | null>(null)
  const measureBodyRef    = useRef<HTMLDivElement | null>(null)

  // Measure the rendered markdown body at the requested width and bump the
  // pane height if Gemini under-sized it. Gemini estimates from a textual
  // model of the content; the real rendered height is what we honor.
  useLayoutEffect(() => {
    if (!content) {
      setMeasuredHeight(null)
      return
    }
    const node = measureBodyRef.current
    if (!node) return
    // scrollHeight already includes the body's 12px bottom padding via the
    // .pin-panel__body class on the measurer's outer wrapper.
    // We trust the measurement, NOT Gemini's height guess — the whole point
    // of measuring is to size to the actual rendered content, not honor
    // over-requests that leave dead space below the text.
    const bodyHeight = node.scrollHeight
    const total      = HEADER_HEIGHT + bodyHeight + HEIGHT_SAFETY
    setMeasuredHeight(clampHeight(total))
  }, [content])

  useEffect(() => {
    const onMessage = (msg: ServerMessage) => {
      if (msg.type === "pin_pane_set") {
        console.log("[pin-panel] received pin_pane_set", {
          title:        msg.title,
          width:        msg.width,
          height:       msg.height,
          currentStage: stage,
          hasContent:   content !== null,
        })
        const next: PaneContent = {
          title:    msg.title,
          markdown: stripDuplicateTitleHeading(msg.title, msg.markdown),
          width:    clampWidth(msg.width),
          height:   msg.height,
        }
        if (content === null) {
          console.log("[pin-panel] first-time expand path")
          setContent(next)
          setStage("collapsed")
          requestAnimationFrame(() => setStage("expanding-width"))
        } else {
          console.log("[pin-panel] swap path: setting pendingRef, stage -> collapsing-to-swap")
          pendingContentRef.current = next
          setStage("collapsing-to-swap")
        }
        return false
      }
      if (msg.type === "pin_pane_clear") {
        console.log("[pin-panel] received pin_pane_clear", {
          currentStage: stage,
          hasContent:   content !== null,
        })
        if (content !== null) {
          pendingContentRef.current = null
          setStage("collapsing-to-clear")
        }
        return false
      }
      return false
    }
    chrome.runtime.onMessage.addListener(onMessage)
    return () => chrome.runtime.onMessage.removeListener(onMessage)
  }, [content])

  // Swap handoff. Driven by a fixed timer (matching the CSS transition) rather
  // than transitionEnd, because the shrink fires width AND height transitionEnd
  // events — the trailing one can arrive AFTER we've entered "expanding-width"
  // and gets misinterpreted as that stage's completion, skipping the state
  // machine ahead by one.
  useEffect(() => {
    if (stage !== "collapsing-to-swap") return
    console.log("[pin-panel] swap timer scheduled (380ms)")
    const id = setTimeout(() => {
      const pending = pendingContentRef.current
      console.log("[pin-panel] swap timer fired", { hasPending: pending !== null })
      if (!pending) {
        console.warn("[pin-panel] BUG: swap timer fired with no pending content — stuck on puck")
        return
      }
      pendingContentRef.current = null
      setContent(pending)
      requestAnimationFrame(() => {
        console.log("[pin-panel] rAF: stage -> expanding-width")
        setStage("expanding-width")
      })
    }, 380)
    return () => {
      console.log("[pin-panel] swap timer cleanup (clearTimeout)")
      clearTimeout(id)
    }
  }, [stage])

  if (content === null) return null

  const handleRootClick = () => {
    if (stage === "collapsed") setStage("expanding-width")
  }

  const handleCollapseClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (stage === "open") setStage("collapsed")
  }

  const handleTransitionEnd = (e: React.TransitionEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return
    if (e.propertyName !== "width" && e.propertyName !== "height") return
    if (stage === "expanding-width" && e.propertyName === "width") {
      setStage("expanding-height")
    } else if (stage === "expanding-height" && e.propertyName === "height") {
      setStage("open")
    } else if (stage === "collapsing-to-clear" && e.propertyName === "width") {
      setContent(null)
      setStage("collapsed")
    }
  }

  const isCollapsedVisual =
    stage === "collapsed" || stage === "collapsing-to-clear" || stage === "collapsing-to-swap"

  const stageClass =
    isCollapsedVisual
      ? "collapsed"
      : stage === "expanding-width"
        ? "expanding-width"
        : stage === "expanding-height"
          ? "expanding-height"
          : "open"

  const inlineStyle: React.CSSProperties = {
    zIndex: 2147483646,
    width:  content.width,
    height: measuredHeight ?? content.height,
  }

  // Hidden measurer: same width and class as the real body, off-screen. We
  // read its scrollHeight in the layout effect above to size the real pane.
  // The class applies the real horizontal/bottom padding so scrollHeight
  // already includes BODY_PAD_TOTAL — beware double-counting in the effect.
  const measurerStyle: React.CSSProperties = {
    position:      "fixed",
    top:           -99999,
    left:          -99999,
    width:         content.width,
    visibility:    "hidden",
    pointerEvents: "none",
  }

  return (
    <div>
      <div
        ref={measureBodyRef}
        className="pin-panel__body"
        style={measurerStyle}
        aria-hidden="true"
      >
        <MarkdownErrorBoundary markdown={content.markdown}>
          <MarkdownBody markdown={content.markdown} />
        </MarkdownErrorBoundary>
      </div>
      <div
        className={`pin-panel ${stageClass}`}
        style={inlineStyle}
        onClick={handleRootClick}
        onTransitionEnd={handleTransitionEnd}
        aria-label="Pinned items"
      >
        {isCollapsedVisual ? (
          <div className="pin-panel__puck-icon">
            <UnfoldHorizontal size={18} style={{ transform: "rotate(-45deg)" }} />
          </div>
        ) : (
          <div className="pin-panel__inner">
            <div className="pin-panel__header">
              <span className="pin-panel__title">{content.title}</span>
              <button
                type="button"
                className="pin-panel__collapse-btn"
                onClick={handleCollapseClick}
                aria-label="Collapse pin panel"
              >
                <FoldHorizontal size={16} style={{ transform: "rotate(-45deg)" }} />
              </button>
            </div>
            <div className="pin-panel__body">
              <MarkdownErrorBoundary markdown={content.markdown}>
                <MarkdownBody markdown={content.markdown} />
              </MarkdownErrorBoundary>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default PinPanel
