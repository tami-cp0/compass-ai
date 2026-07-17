import { useEffect, useRef } from "react"

import { player } from "../lib/audio-runtime"

export type BarsMode = "voice" | "idle" | "flatline"

const BAR_COUNT       = 14
const MIN_BAR_HEIGHT  = 4
const MAX_BAR_HEIGHT  = 24
const FLAT_BAR_HEIGHT = 5
const FREQ_RANGE_HZ   = { low: 80, high: 3000 }

// Bars visualize Compass's voice (the player's output analyser), not the
// user's mic — the user already knows when they're talking; what they can't
// tell is whether Compass is responding. Flat while Compass is silent.
export function FrequencyBars({ mode }: { mode: BarsMode }) {
  const barsRef = useRef<(HTMLDivElement | null)[]>([])
  const rafRef  = useRef<number>()

  useEffect(() => {
    const stop = () => {
      if (rafRef.current !== undefined) cancelAnimationFrame(rafRef.current)
      barsRef.current.forEach(b => { if (b) b.style.height = `${MIN_BAR_HEIGHT}px` })
    }

    if (mode !== "voice") { stop(); return }

    const smoothed = new Array<number>(BAR_COUNT).fill(MIN_BAR_HEIGHT)
    let data: Uint8Array | null = null

    const tick = () => {
      // Re-fetched every frame: the player recreates its AudioContext (and
      // analyser) across offline pauses, so a cached reference goes stale.
      const analyser = player.getAnalyser()
      if (analyser) {
        if (!data || data.length !== analyser.frequencyBinCount) {
          data = new Uint8Array(analyser.frequencyBinCount)
        }
        analyser.getByteFrequencyData(data)
        const nyquist  = analyser.context.sampleRate / 2
        const startBin = Math.floor((FREQ_RANGE_HZ.low  / nyquist) * analyser.frequencyBinCount)
        const endBin   = Math.floor((FREQ_RANGE_HZ.high / nyquist) * analyser.frequencyBinCount)
        const step     = Math.max(1, Math.floor((endBin - startBin) / BAR_COUNT))
        barsRef.current.forEach((bar, i) => {
          if (!bar) return
          let sum = 0
          for (let j = 0; j < step; j++) sum += data![startBin + i * step + j] ?? 0
          const avg    = sum / step
          const target = Math.max(MIN_BAR_HEIGHT, (avg / 255) * MAX_BAR_HEIGHT)
          smoothed[i]  = smoothed[i] * 0.5 + target * 0.5
          bar.style.height = `${smoothed[i]}px`
        })
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)

    return stop
  }, [mode])

  const isFlat = mode === "flatline"

  return (
    <div className="relative flex items-center justify-center h-8 z-10" style={{ width: `${BAR_COUNT * 3 + (BAR_COUNT - 1) * 3}px` }}>
      <div
        className="absolute inset-0 flex items-center justify-center gap-[3px]"
        style={{ opacity: isFlat ? 0 : 1, transition: "opacity 200ms ease" }}
      >
        {Array.from({ length: BAR_COUNT }).map((_, i) => (
          <div
            key={i}
            ref={el => { barsRef.current[i] = el }}
            className="w-[3px] bg-white rounded-full"
            style={{ height: `${MIN_BAR_HEIGHT}px`, transition: "height 75ms ease" }}
          />
        ))}
      </div>
      <div
        className="absolute inset-0 flex items-center justify-center gap-[3px]"
        style={{ opacity: isFlat ? 1 : 0, transition: "opacity 200ms ease" }}
        aria-hidden={!isFlat}
      >
        {Array.from({ length: BAR_COUNT }).map((_, i) => (
          <div
            key={i}
            className="w-[3px] bg-white rounded-full"
            style={{ height: `${FLAT_BAR_HEIGHT}px` }}
          />
        ))}
      </div>
    </div>
  )
}
