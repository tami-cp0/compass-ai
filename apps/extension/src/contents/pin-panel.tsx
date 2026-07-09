import type { PaneLink, ServerMessage } from "@compass-ai/types"
import globalsCss from "data-text:~/styles/globals.css"
import pinPanelCss from "data-text:~/styles/pin-panel.css"
import { ArrowUpRight, FoldHorizontal, UnfoldHorizontal } from "lucide-react"
import type { PlasmoCSConfig } from "plasmo"
import { Children, Component, isValidElement, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
// Vendored esbuild bundle, NOT the npm package directly: Plasmo's Parcel
// mangles ESM re-exports inside react-markdown's dependency tree and crashes
// it at runtime. See src/vendor/markdown-entry.mjs.
import ReactMarkdown, { remarkGfm } from "../vendor/react-markdown"

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
  columns:  number
  links:    PaneLink[]
}

// Pane is fixed top-right. To avoid overlapping the centered pill, its left
// edge stays PILL_GAP px right of the pill's right edge. No handle to the pill
// from this content script (separate shadow root), so assume max pill width.
const PANE_RIGHT_MARGIN = 24
const PILL_GAP           = 24
const MAX_PILL_WIDTH     = 200
const MAX_WIDTH          = 760
// Largest width the pane may take on this viewport (right of the pill, inside
// the right margin). Exposed so the width auto-fit can grow up to it.
const maxPaneWidth = (): number => {
  const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1280
  const pillRightEdge = viewportWidth / 2 + MAX_PILL_WIDTH / 2
  const maxByViewport = Math.floor(viewportWidth - PANE_RIGHT_MARGIN - PILL_GAP - pillRightEdge)
  return Math.max(220, Math.min(MAX_WIDTH, maxByViewport))
}
const clampWidth = (requested: number): number =>
  Math.max(220, Math.min(maxPaneWidth(), Math.round(requested)))

// Mirrors the CSS in pin-panel.css. Header is fixed-height; body has 12px
// bottom padding only (header's 8px bottom acts as the body's top padding).
const HEADER_HEIGHT  = 38
const BODY_PAD_TOTAL = 12
const HEIGHT_SAFETY  = 8
// Ceiling is the viewport minus the 24px top gap (in CSS `top`) and an equal
// bottom gap. No fixed cap — a tall screen gets a tall pane.
const clampHeight = (requested: number): number => {
  const viewportHeight = typeof window !== "undefined" ? window.innerHeight : 800
  const maxByViewport  = Math.floor(viewportHeight - 2 * PANE_RIGHT_MARGIN)
  return Math.max(120, Math.min(maxByViewport, Math.round(requested)))
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

// react-markdown can crash on some inputs (notably malformed tables). Catch it
// so the pane falls back to plain text instead of blanking the whole panel.
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

// Normalize markdown before rendering, targeting shapes that have crashed the
// parser or rendered raw: mixed line endings, BOM/zero-width chars, fully
// indented bodies (read as code blocks), model-added outer fences, and
// malformed GFM table separators/whitespace.
const sanitizeMarkdown = (raw: string): string => {
  // 1) line endings
  let s = raw.replace(/\r\n?/g, "\n")
  // 2) strip BOM + zero-width chars; non-breaking spaces → plain spaces
  s = s.replace(/[﻿​‌‍⁠]/g, "").replace(/ /g, " ")
  // 2b) Dedent. If every non-empty line is indented, markdown reads 4+ spaces
  // as a code block and renders raw. Stripping the common indent is safe —
  // intentional nesting keeps top-level lines at column 0, so it never qualifies.
  {
    const all = s.split("\n")
    const nonEmpty = all.filter((l) => l.trim() !== "")
    if (nonEmpty.length > 0) {
      const common = Math.min(...nonEmpty.map((l) => (l.match(/^ */) as RegExpMatchArray)[0].length))
      if (common > 0) s = all.map((l) => l.slice(common)).join("\n")
    }
  }
  // 2c) Unwrap a model-added outer fence. The model sometimes wraps the whole
  // body in ```/~~~ (with or without an info string), rendering the pane as one
  // literal code block. Render-side backstop to the server's unwrap
  // (pane-estimate.ts). Never unwrap info string "chart" — that's a real
  // single-chart body.
  {
    const all = s.split("\n")
    let first = 0
    while (first < all.length && all[first].trim() === "") first++
    let last = all.length - 1
    while (last >= 0 && all[last].trim() === "") last--
    if (last - first >= 2) {
      const open = all[first].trim().match(/^(`{3,}|~{3,})\s*(\S*)\s*$/)
      if (open && open[2].toLowerCase() !== "chart") {
        const close = all[last].trim().match(/^(`{3,}|~{3,})\s*$/)
        if (close && close[1][0] === open[1][0] && close[1].length >= open[1].length) {
          s = all.slice(first + 1, last).join("\n")
        } else if (/^\s{0,3}(`{3,}|~{3,})/m.test(all.slice(first + 1).join("\n"))) {
          // Unclosed wrapper hiding nested fences: strip the opener only.
          s = all.slice(first + 1).join("\n")
        }
      }
    }
  }
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
    // Rebuild the separator to plain `---` cells matching the header's column
    // count: strips crash-prone alignment markers (`:---`) and repairs
    // mismatched column counts.
    const headerCells = splitRow(header)
    const repaired = headerCells.map(() => "---").join(" | ")
    lines[i + 1] = `| ${repaired} |`
  }
  return lines.join("\n")
}

// ─── Signed-value tinting (+3.2% green, -1.8% red) ───────────────────────────
// Boundary checks stop date ranges ("2024-2025") and mid-word hyphens from
// matching; the sign stays in the text so color is reinforcement, never the
// only signal.
const DELTA_RE = /[+\-−](?:₦|\$|€)?\d+(?:,\d{3})*(?:\.\d+)?%?/g
const BEFORE_BLOCK = /[A-Za-z0-9.%₦$€]/
const AFTER_BLOCK  = /[A-Za-z0-9₦$€]/

const tintDeltas = (text: string): ReactNode => {
  DELTA_RE.lastIndex = 0
  const parts: ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  while ((m = DELTA_RE.exec(text)) !== null) {
    const before = text[m.index - 1]
    const after  = text[m.index + m[0].length]
    if (before !== undefined && BEFORE_BLOCK.test(before)) continue
    if (after  !== undefined && AFTER_BLOCK.test(after))  continue
    if (m.index > last) parts.push(text.slice(last, m.index))
    parts.push(
      <span key={m.index} className={m[0][0] === "+" ? "pp-up" : "pp-down"}>
        {m[0]}
      </span>
    )
    last = m.index + m[0].length
  }
  if (parts.length === 0) return text
  if (last < text.length) parts.push(text.slice(last))
  return <>{parts}</>
}

// Tint only direct string children — nested elements (strong, em, …) are
// handled by their own component overrides, so nothing is walked twice.
const tintChildren = (children: ReactNode): ReactNode =>
  Children.map(children, (child) =>
    typeof child === "string" ? tintDeltas(child) : child
  )

// ─── Numeric table cells: right-aligned via pp-num ───────────────────────────
const textOf = (node: ReactNode): string => {
  if (node === null || node === undefined || typeof node === "boolean") return ""
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(textOf).join("")
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children)
  return ""
}

const NUMERIC_CELL_RE = /^[+\-−]?\s*(?:₦|\$|€)?\s*[\d,]+(?:\.\d+)?\s*(?:%|[KMBTx])?$/
const isNumericCell = (s: string): boolean => NUMERIC_CELL_RE.test(s.trim())

// ─── Chart blocks (```chart fences) ──────────────────────────────────────────
// Categorical palette tuned to sit on the pane's green-glass surface. Assigned
// by slot (never cycled), kept perceptually distinct for CVD safety. Color is
// never the only signal — every chart also renders labels/values.
const SERIES_HUES: Array<[number, number, number]> = [
  [168, 62, 52], // teal
  [140, 48, 55], // green
  [45,  78, 58], // gold
  [200, 68, 58], // sky
  [266, 52, 66], // violet
  [96,  50, 56], // lime
  [20,  72, 60], // amber
]
// Translucent tint so the blurred pane shows through (that's what reads as
// glass). `glassFill` is the flat fallback for legend swatches; bars/slices
// use the sheen gradient below.
const GLASS_ALPHA = 0.42
const glassFill = (h: number, s: number, l: number): string => `hsla(${h}, ${s}%, ${l}%, ${GLASS_ALPHA})`
const SERIES_COLORS = SERIES_HUES.map(([h, s, l]) => glassFill(h, s, l))
const OTHER_COLOR = "hsla(0, 0%, 100%, 0.30)"
// Shared lit rim — the same faint white sheen the pane uses as its inset top
// highlight, applied as a thin stroke so each shape catches light like glass.
const GLASS_EDGE = "hsla(0, 0%, 100%, 0.40)"
const GLASS_EDGE_W = 0.75
const MAX_SLICES = 7

// Unique gradient ids per hue slot so multiple charts on a pane don't collide.
const sheenId = (slot: number) => `pp-glass-sheen-${slot}`
const GLOSS_ID = "pp-glass-gloss"

// Per-hue top→bottom depth gradient plus a shared white GLOSS highlight band
// over the top third — the specular sheen that reads as lit glass.
const SheenDefs = () => (
  <defs>
    {SERIES_HUES.map(([h, s, l], i) => (
      <linearGradient key={i} id={sheenId(i)} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor={`hsla(${h}, ${Math.min(100, s + 14)}%, ${Math.min(92, l + 20)}%, 0.62)`} />
        <stop offset="45%" stopColor={`hsla(${h}, ${s}%, ${l}%, 0.44)`} />
        <stop offset="100%" stopColor={`hsla(${h}, ${s}%, ${Math.max(0, l - 14)}%, 0.30)`} />
      </linearGradient>
    ))}
    <linearGradient id={GLOSS_ID} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stopColor="hsla(0, 0%, 100%, 0.55)" />
      <stop offset="35%" stopColor="hsla(0, 0%, 100%, 0.12)" />
      <stop offset="55%" stopColor="hsla(0, 0%, 100%, 0)" />
    </linearGradient>
  </defs>
)
const sheenFill = (slot: number) => `url(#${sheenId(slot % SERIES_HUES.length)})`
const GLOSS_FILL = `url(#${GLOSS_ID})`

interface ChartDatum {
  label:    string
  value:    number
  display?: string
  // Stacked bars: one datum (bar) split into segments by series key. When
  // present, segments drive the bar and `value` (its sum) is derived.
  segments?: Record<string, number>
}

// Declared series for a stacked bar chart. Order fixes color-by-slot and
// legend order; keys map segment values to a color + human label.
interface ChartSeries {
  key:   string
  label: string
}

interface ChartSpec {
  type:    "pie" | "bar"
  data:    ChartDatum[]
  xLabel?: string
  yLabel?: string
  series?: ChartSeries[]
}

const cleanAxisLabel = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, 40) : undefined

// A datum's total: explicit `value`, else the sum of its segments.
const datumTotal = (d: ChartDatum): number => {
  if (typeof d.value === "number" && isFinite(d.value)) return d.value
  if (d.segments) {
    return Object.values(d.segments).reduce(
      (s, v) => s + (typeof v === "number" && isFinite(v) && v >= 0 ? v : 0),
      0
    )
  }
  return NaN
}

const parseChartSpec = (source: string): ChartSpec | null => {
  try {
    const parsed = JSON.parse(source) as ChartSpec
    if (parsed.type !== "pie" && parsed.type !== "bar") return null
    if (!Array.isArray(parsed.data) || parsed.data.length === 0) return null

    // Validate declared series (stacked bars only).
    const series =
      Array.isArray(parsed.series)
        ? parsed.series
            .filter((s) => s && typeof s.key === "string" && s.key !== "")
            .map((s) => ({ key: s.key, label: cleanAxisLabel(s.label) ?? s.key }))
            .slice(0, SERIES_HUES.length)
        : undefined
    const seriesKeys = series?.map((s) => s.key)

    const data = parsed.data
      .filter((d) => typeof d.label === "string")
      .map((d): ChartDatum => {
        // Keep only segments whose key is a declared series and whose value is
        // a valid non-negative number — an undeclared key would have no color.
        let segments: Record<string, number> | undefined
        if (seriesKeys && d.segments && typeof d.segments === "object") {
          segments = {}
          for (const k of seriesKeys) {
            const v = d.segments[k]
            if (typeof v === "number" && isFinite(v) && v >= 0) segments[k] = v
          }
          if (Object.keys(segments).length === 0) segments = undefined
        }
        // Total must come from what will actually be drawn: the CLEANED
        // segments, not the raw ones — an undeclared segment key contributes no
        // bar segment, so it must not inflate the bar's height or the axis.
        const value = segments
          ? Object.values(segments).reduce((s, v) => s + v, 0)
          : datumTotal(d)
        return { label: d.label, value, display: d.display, segments }
      })
      .filter((d) => isFinite(d.value) && d.value >= 0)

    if (data.length === 0) return null
    return {
      type:   parsed.type,
      data,
      xLabel: cleanAxisLabel(parsed.xLabel),
      yLabel: cleanAxisLabel(parsed.yLabel),
      // Series only meaningful for stacked bars with matching segment data.
      series: series && series.length > 0 && data.some((d) => d.segments) ? series : undefined,
    }
  } catch {
    return null
  }
}

// Fold rows beyond the palette into "Other" so a slot is never invented. For
// stacked bars, the folded "Other" carries no segments and renders as a single
// bar — acceptable as a tail bucket. Keeps the top MAX_SLICES-1 by total.
const foldToSlots = (data: ChartDatum[]): ChartDatum[] => {
  if (data.length <= MAX_SLICES) return data
  const sorted = [...data].sort((a, b) => b.value - a.value)
  const kept = sorted.slice(0, MAX_SLICES - 1)
  const rest = sorted.slice(MAX_SLICES - 1)
  return [...kept, { label: "Other", value: rest.reduce((s, d) => s + d.value, 0) }]
}

const fmtValue = (d: ChartDatum): string =>
  d.display ?? d.value.toLocaleString("en-US", { maximumFractionDigits: 2 })

const sliceColor = (i: number, isOther: boolean): string =>
  isOther ? OTHER_COLOR : SERIES_COLORS[i]

// Donut segment path with a small angular gap so the glass shows between
// segments (the 2px surface-gap rule).
const donutArc = (
  cx: number, cy: number, r: number, thickness: number,
  startAngle: number, endAngle: number
): string => {
  const inner = r - thickness
  const pt = (radius: number, a: number) =>
    `${cx + radius * Math.cos(a)} ${cy + radius * Math.sin(a)}`
  const large = endAngle - startAngle > Math.PI ? 1 : 0
  return [
    `M ${pt(r, startAngle)}`,
    `A ${r} ${r} 0 ${large} 1 ${pt(r, endAngle)}`,
    `L ${pt(inner, endAngle)}`,
    `A ${inner} ${inner} 0 ${large} 0 ${pt(inner, startAngle)}`,
    "Z",
  ].join(" ")
}

const PieChart = ({ data }: { data: ChartDatum[] }) => {
  const total = data.reduce((s, d) => s + d.value, 0)
  if (total <= 0) return null
  const R = 54
  const THICKNESS = 18
  const GAP_RAD = 2 / R // ≈2px gap at the outer radius
  let angle = -Math.PI / 2
  const segments = data.map((d, i) => {
    const sweep = (d.value / total) * Math.PI * 2
    const pad = data.length > 1 ? Math.min(GAP_RAD, sweep / 4) : 0
    const seg = {
      d: donutArc(60, 60, R, THICKNESS, angle + pad / 2, Math.max(angle + pad / 2, angle + sweep - pad / 2)),
      color: sliceColor(i, d.label === "Other" && i === data.length - 1),
      datum: d,
      share: d.value / total,
    }
    angle += sweep
    return seg
  })
  return (
    <div className="pp-chart pp-chart--pie">
      <svg viewBox="0 0 120 120" width={110} height={110} role="img" aria-label="Pie chart">
        <SheenDefs />
        {data.length === 1 ? (
          // A full-circle arc degenerates (start === end) — render a ring.
          <circle cx={60} cy={60} r={45} fill="none" stroke={sheenFill(0)} strokeWidth={18}>
            <title>{`${data[0].label}: ${fmtValue(data[0])} (100.0%)`}</title>
          </circle>
        ) : (
          segments.map((s, i) => {
            const isOther = s.datum.label === "Other" && i === segments.length - 1
            return (
              <path key={i} d={s.d} fill={isOther ? OTHER_COLOR : sheenFill(i)} stroke={GLASS_EDGE} strokeWidth={GLASS_EDGE_W}>
                <title>{`${s.datum.label}: ${fmtValue(s.datum)} (${(s.share * 100).toFixed(1)}%)`}</title>
              </path>
            )
          })
        )}
      </svg>
      <div className="pp-chart__legend">
        {segments.map((s, i) => (
          <div key={i} className="pp-chart__legend-row">
            <span
              className="pp-chart__swatch"
              style={{ background: s.color, boxShadow: `inset 0 0 0 ${GLASS_EDGE_W}px ${GLASS_EDGE}` }}
            />
            <span className="pp-chart__label">{s.datum.label}</span>
            <span className="pp-chart__value">{(s.share * 100).toFixed(1)}%</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// Compact axis-tick formatter: 730341.6 → "730K", 1_556_241 → "1.6M". Keeps
// the Y-axis narrow so the plot area stays wide in a ≤500px pane.
const fmtTick = (v: number): string => {
  const abs = Math.abs(v)
  if (abs >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(abs >= 1e10 ? 0 : 1)}B`
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(abs >= 1e7 ? 0 : 1)}M`
  if (abs >= 1_000) return `${(v / 1_000).toFixed(abs >= 1e4 ? 0 : 1)}K`
  return v.toLocaleString("en-US", { maximumFractionDigits: 1 })
}

// A "nice" axis maximum at or above the data max, so ticks land on round
// numbers (100K, 250K, 500K …) instead of arbitrary fractions of the data.
const niceMax = (raw: number): number => {
  if (raw <= 0) return 1
  const pow = Math.pow(10, Math.floor(Math.log10(raw)))
  const n = raw / pow
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10
  return step * pow
}

const truncLabel = (s: string, n = 6): string => (s.length > n ? s.slice(0, n - 1) + "…" : s)

// Vertical bar chart with labelled axes. Optional xLabel/yLabel are model-
// supplied axis TITLES (per-tick text comes from the data); a title widens its
// margin so it never overlaps the ticks. Hover title carries the full label +
// exact value.
const BAR_VIEW_W = 300
const BAR_LEGEND_ROW_H = 12
const barViewH = (hasXTitle: boolean, legendRows: number) =>
  (hasXTitle ? 184 : 170) + legendRows * BAR_LEGEND_ROW_H

const fmtNum = (v: number): string => v.toLocaleString("en-US", { maximumFractionDigits: 2 })

const BarChart = ({
  data,
  xLabel,
  yLabel,
  series,
}: {
  data:    ChartDatum[]
  xLabel?: string
  yLabel?: string
  series?: ChartSeries[]
}) => {
  const rawMax = Math.max(...data.map((d) => d.value))
  if (rawMax <= 0) return null
  const axisMax = niceMax(rawMax)

  const legendRows = series ? series.length : 0
  const viewH = barViewH(!!xLabel, legendRows)
  const legendH = legendRows * BAR_LEGEND_ROW_H
  // Extra room: left for a rotated Y title, bottom for an X title beneath ticks
  // (plus the legend block below everything else).
  const pad = {
    top:    8,
    right:  6,
    bottom: 30 + (xLabel ? 14 : 0) + legendH,
    left:   34 + (yLabel ? 12 : 0),
  }

  const plotW = BAR_VIEW_W - pad.left - pad.right
  const plotH = viewH - pad.top - pad.bottom
  const y0 = pad.top + plotH // baseline
  const yFor = (v: number) => pad.top + plotH * (1 - v / axisMax)

  const TICK_COUNT = 4
  const ticks = Array.from({ length: TICK_COUNT + 1 }, (_, i) => (axisMax / TICK_COUNT) * i)

  const slotW = plotW / data.length
  const barW = Math.min(slotW * 0.62, 40)
  const seriesColor = (i: number) => glassFill(...SERIES_HUES[i % SERIES_HUES.length])

  return (
    <div className="pp-chart pp-chart--bar">
      <svg viewBox={`0 0 ${BAR_VIEW_W} ${viewH}`} width="100%" role="img" aria-label="Bar chart">
        <SheenDefs />
        {/* Y gridlines + tick labels */}
        {ticks.map((t, i) => {
          const y = yFor(t)
          return (
            <g key={i}>
              <line
                x1={pad.left} y1={y} x2={BAR_VIEW_W - pad.right} y2={y}
                stroke="hsla(0,0%,100%,0.12)" strokeWidth={0.75}
              />
              <text
                x={pad.left - 5} y={y} textAnchor="end" dominantBaseline="middle"
                fontSize={8} fill="hsla(0,0%,100%,0.7)" style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {fmtTick(t)}
              </text>
            </g>
          )
        })}
        {/* Baseline (X axis) */}
        <line
          x1={pad.left} y1={y0} x2={BAR_VIEW_W - pad.right} y2={y0}
          stroke="hsla(0,0%,100%,0.28)" strokeWidth={1}
        />
        {/* Bars + X-axis category labels. Stacked when series+segments present;
            otherwise a single bar coloured by slot. */}
        {data.map((d, i) => {
          const cx = pad.left + slotW * i + slotW / 2
          const isOther = d.label === "Other" && i === data.length - 1
          const stacked = series && d.segments
          return (
            <g key={i}>
              {stacked ? (
                (() => {
                  let acc = 0
                  return series!.map((s, si) => {
                    const v = d.segments![s.key] ?? 0
                    if (v <= 0) return null
                    const yTop = yFor(acc + v)
                    const yBot = yFor(acc)
                    const segH = Math.max(0.5, yBot - yTop)
                    acc += v
                    return (
                      <g key={s.key}>
                        <rect
                          x={cx - barW / 2} y={yTop} width={barW} height={segH}
                          fill={sheenFill(si)} stroke={GLASS_EDGE} strokeWidth={GLASS_EDGE_W}
                        >
                          <title>{`${d.label} — ${s.label}: ${fmtNum(v)}`}</title>
                        </rect>
                        {/* specular gloss over the top of the segment */}
                        <rect
                          x={cx - barW / 2} y={yTop} width={barW} height={segH}
                          fill={GLOSS_FILL} pointerEvents="none"
                        />
                      </g>
                    )
                  })
                })()
              ) : (
                (() => {
                  const h = Math.max(1, (d.value / axisMax) * plotH)
                  return (
                    <g>
                      <rect
                        x={cx - barW / 2} y={y0 - h} width={barW} height={h}
                        rx={2} fill={isOther ? OTHER_COLOR : sheenFill(i)}
                        stroke={GLASS_EDGE} strokeWidth={GLASS_EDGE_W}
                      >
                        <title>{`${d.label}: ${fmtValue(d)}`}</title>
                      </rect>
                      <rect
                        x={cx - barW / 2} y={y0 - h} width={barW} height={h}
                        rx={2} fill={GLOSS_FILL} pointerEvents="none"
                      />
                    </g>
                  )
                })()
              )}
              <text
                x={cx} y={y0 + 9} textAnchor="middle" dominantBaseline="hanging"
                fontSize={8} fill="hsla(0,0%,100%,0.82)"
              >
                {truncLabel(d.label)}
                <title>{`${d.label}: ${fmtValue(d)}`}</title>
              </text>
            </g>
          )
        })}
        {/* Series legend (stacked bars only), below the X title. */}
        {series && series.map((s, si) => {
          const ly = viewH - legendH + si * BAR_LEGEND_ROW_H + BAR_LEGEND_ROW_H / 2
          return (
            <g key={s.key}>
              <rect
                x={pad.left} y={ly - 4} width={8} height={8} rx={1.5}
                fill={seriesColor(si)} stroke={GLASS_EDGE} strokeWidth={GLASS_EDGE_W}
              />
              <text
                x={pad.left + 12} y={ly} dominantBaseline="middle"
                fontSize={8} fill="hsla(0,0%,100%,0.82)"
              >
                {s.label}
              </text>
            </g>
          )
        })}
        {/* Axis TITLES (model-supplied) */}
        {yLabel && (
          <text
            transform={`translate(9 ${pad.top + plotH / 2}) rotate(-90)`}
            textAnchor="middle" fontSize={8.5} fill="hsla(0,0%,100%,0.6)"
          >
            {yLabel}
          </text>
        )}
        {xLabel && (
          <text
            x={pad.left + plotW / 2} y={viewH - legendH - 3} textAnchor="middle"
            fontSize={8.5} fill="hsla(0,0%,100%,0.6)"
          >
            {xLabel}
          </text>
        )}
      </svg>
    </div>
  )
}

const ChartBlock = ({ source }: { source: string }) => {
  const spec = parseChartSpec(source)
  if (!spec) {
    // Malformed spec: fall back to showing the raw block rather than blanking.
    return <pre className="pp-pre" style={{ whiteSpace: "pre-wrap" }}>{source}</pre>
  }
  const data = foldToSlots(spec.data)
  return spec.type === "pie"
    ? <PieChart data={data} />
    : <BarChart data={data} xLabel={spec.xLabel} yLabel={spec.yLabel} series={spec.series} />
}

// Keep an atomic block (chart, table, code, blockquote) from splitting across
// the column gap in a multi-column pane. Inline because Plasmo's CSS pipeline
// strips some properties from the stylesheet.
const NO_SPLIT: React.CSSProperties = { breakInside: "avoid" }

// ─── Link louvers ─────────────────────────────────────────────────────────────
// Slim glass blades docked below the body — the pane's explicit "open this"
// affordance. Each carries the page title (+ platform tag) and opens the URL.
// Metrics are shared with the height measurement in PinPanel.
const LOUVER_H       = 28
const LOUVER_GAP     = 6
const LOUVER_PAD_BTM = 12
const louverSectionH = (n: number): number =>
  n > 0 ? n * LOUVER_H + (n - 1) * LOUVER_GAP + LOUVER_PAD_BTM : 0

const LinkLouvers = ({ links }: { links: PaneLink[] }) => (
  <div className="pp-louvers">
    {links.map((l, i) => (
      <a
        key={i}
        className="pp-louver"
        href={l.url}
        target="_blank"
        rel="noopener noreferrer"
        title={l.url}
        // Stagger the travelling sheen so the blades catch light in sequence,
        // like slats of an actual louver.
        style={{ ["--louver-delay" as string]: `${i * 1.6}s` }}
        onClick={(e) => e.stopPropagation()}
      >
        <span className="pp-louver__title">{l.title}</span>
        {l.platform && <span className="pp-louver__platform">{l.platform}</span>}
        <ArrowUpRight size={13} className="pp-louver__arrow" />
      </a>
    ))}
  </div>
)

const MarkdownBody = ({ markdown }: { markdown: string }) => (
  <ReactMarkdown
    remarkPlugins={[remarkGfm]}
    components={{
      p:          ({ node, children, ...props }) => <p className="pp-p" {...props}>{tintChildren(children)}</p>,
      ul:         ({ node, ...props }) => <ul className="pp-ul" {...props} />,
      ol:         ({ node, ...props }) => <ol className="pp-ol" {...props} />,
      li:         ({ node, children, ...props }) => <li className="pp-li" {...props}>{tintChildren(children)}</li>,
      h1:         ({ node, ...props }) => <h3 className="pp-h" {...props} />,
      h2:         ({ node, ...props }) => <h3 className="pp-h" {...props} />,
      h3:         ({ node, ...props }) => <h3 className="pp-h" {...props} />,
      h4:         ({ node, ...props }) => <h4 className="pp-h" {...props} />,
      code:       ({ node, ...props }) => <code className="pp-code" {...props} />,
      pre:        ({ node, children, ...props }) => {
        // ```chart fences render as charts instead of code blocks.
        const child = Array.isArray(children) ? children[0] : children
        if (
          isValidElement(child) &&
          /language-chart/.test(((child.props as { className?: string }).className) ?? "")
        ) {
          return (
            <div style={NO_SPLIT}>
              <ChartBlock source={textOf((child.props as { children?: ReactNode }).children).trim()} />
            </div>
          )
        }
        return <pre className="pp-pre" style={NO_SPLIT} {...props}>{children}</pre>
      },
      table:      ({ node, ...props }) => <table className="pp-table" style={NO_SPLIT} {...props} />,
      td:         ({ node, children, ...props }) => (
        <td className={isNumericCell(textOf(children)) ? "pp-num" : undefined} {...props}>
          {tintChildren(children)}
        </td>
      ),
      strong:     ({ node, children, ...props }) => <strong className="pp-strong" {...props}>{tintChildren(children)}</strong>,
      em:         ({ node, children, ...props }) => <em className="pp-em" {...props}>{tintChildren(children)}</em>,
      del:        ({ node, ...props }) => <del className="pp-del" {...props} />,
      blockquote: ({ node, ...props }) => <blockquote className="pp-blockquote" style={NO_SPLIT} {...props} />,
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
  const [measuredWidth,  setMeasuredWidth]  = useState<number | null>(null)
  const pendingContentRef = useRef<PaneContent | null>(null)
  const measureBodyRef    = useRef<HTMLDivElement | null>(null)
  // Mirrors `stage` so the message-handler effect (deps: [content]) can read the
  // current stage without a stale closure.
  const stageRef          = useRef<PanelStage>(stage)
  stageRef.current = stage

  // Measure the rendered markdown body and honor the real height over Gemini's
  // estimate (which is derived from a textual model of the content).
  useLayoutEffect(() => {
    if (!content) {
      setMeasuredHeight(null)
      setMeasuredWidth(null)
      return
    }
    const node = measureBodyRef.current
    if (!node) return

    // Pass 1 — width. Widen the pane (up to the viewport max) if a wide table
    // or chart overflows horizontally. Prose wraps, so only wide blocks trigger it.
    node.style.width = `${content.width}px`
    let paneWidth = content.width
    const overflow = node.scrollWidth
    if (overflow > content.width + 2) {
      paneWidth = clampWidth(overflow + 2)
      node.style.width = `${paneWidth}px` // re-measure height at the final width
    }

    // Pass 2 — height at the final width. scrollHeight already includes the
    // body's 12px bottom padding. We trust the measurement, not Gemini's guess.
    // Link louvers dock below the body and aren't in the measurer.
    const bodyHeight = node.scrollHeight
    const total      = HEADER_HEIGHT + bodyHeight + louverSectionH(content.links.length) + HEIGHT_SAFETY
    const clamped    = clampHeight(total)
    setMeasuredWidth(paneWidth)
    setMeasuredHeight(clamped)
  }, [content])

  useEffect(() => {
    const onMessage = (msg: ServerMessage) => {
      if (msg.type === "pin_pane_set") {
        const next: PaneContent = {
          title:    msg.title,
          markdown: stripDuplicateTitleHeading(msg.title, msg.markdown),
          width:    clampWidth(msg.width),
          height:   msg.height,
          columns:  msg.columns === 2 ? 2 : 1,
          links:    msg.links ?? [],
        }
        const cur = stageRef.current
        const collapsed =
          cur === "collapsed" || cur === "collapsing-to-clear" || cur === "collapsing-to-swap"
        if (content === null || collapsed) {
          // No pane yet, OR the pane is already at puck size (minimized /
          // mid-collapse). There's no open pane to shrink first, so the
          // collapse-then-swap animation would stall and the new content would
          // sit in pendingContentRef forever (the model gets "rendered" but the
          // screen keeps the old pane). Swap content in and expand directly.
          pendingContentRef.current = null
          setContent(next)
          setStage("collapsed")
          requestAnimationFrame(() => setStage("expanding-width"))
        } else {
          pendingContentRef.current = next
          setStage("collapsing-to-swap")
        }
        return false
      }
      if (msg.type === "pin_pane_clear") {
        if (content !== null) {
          pendingContentRef.current = null
          const cur = stageRef.current
          const collapsed =
            cur === "collapsed" || cur === "collapsing-to-clear" || cur === "collapsing-to-swap"
          // A minimized/collapsed pane is already at puck size, so shrinking it
          // fires no width transition — handleTransitionEnd would never clear
          // content and the puck would linger. Drop it immediately in that case;
          // only animate the collapse when the pane is actually expanded.
          if (collapsed) {
            setContent(null)
            setStage("collapsed")
          } else {
            setStage("collapsing-to-clear")
          }
        }
        return false
      }
      if (msg.type === "pin_pane_minimize") {
        // Collapse to the puck but KEEP content — clicking the puck (or a
        // later render) restores it. Used e.g. before a web automation so the
        // pane doesn't cover the page in the agent's screenshot.
        if (content !== null) setStage("collapsed")
        return false
      }
      return false
    }
    chrome.runtime.onMessage.addListener(onMessage)
    return () => chrome.runtime.onMessage.removeListener(onMessage)
  }, [content])

  // Swap handoff via a fixed timer (matching the CSS transition), not
  // transitionEnd: the shrink fires both width AND height events, and the
  // trailing one can be misread as the next stage's completion.
  useEffect(() => {
    if (stage !== "collapsing-to-swap") return
    const id = setTimeout(() => {
      const pending = pendingContentRef.current
      if (!pending) return
      pendingContentRef.current = null
      setContent(pending)
      requestAnimationFrame(() => setStage("expanding-width"))
    }, 380)
    return () => clearTimeout(id)
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
    width:  measuredWidth ?? content.width,
    height: measuredHeight ?? content.height,
    // Plasmo's CSS pipeline strips `backdrop-filter` from the stylesheet
    // (confirmed: the rule never reaches the shadow root). Applying it inline
    // bypasses that pipeline so the frosted-glass blur actually renders.
    backdropFilter: "blur(5px) saturate(1.25)",
    WebkitBackdropFilter: "blur(5px) saturate(1.25)",
  }

  // Multi-column flow (model opts in via columns:2) roughly halves tall content
  // instead of clipping. Inline because Plasmo strips some properties; the
  // measurer gets the SAME columns so its scrollHeight matches the real render.
  const columnStyle: React.CSSProperties =
    content.columns > 1 ? { columnCount: content.columns, columnGap: 16 } : {}

  // Hidden off-screen measurer. The layout effect sets its width and reads
  // scrollHeight; the class carries the real padding, so scrollHeight already
  // includes BODY_PAD_TOTAL — beware double-counting.
  const measurerStyle: React.CSSProperties = {
    position:      "fixed",
    top:           -99999,
    left:          -99999,
    visibility:    "hidden",
    pointerEvents: "none",
    ...columnStyle,
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
            <div className="pin-panel__body" style={{ ...columnStyle, overflowY: "auto", overflowX: "hidden" }}>
              <MarkdownErrorBoundary markdown={content.markdown}>
                <MarkdownBody markdown={content.markdown} />
              </MarkdownErrorBoundary>
            </div>
            {content.links.length > 0 && <LinkLouvers links={content.links} />}
          </div>
        )}
      </div>
    </div>
  )
}

export default PinPanel
