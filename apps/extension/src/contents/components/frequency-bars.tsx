import { useEffect, useRef } from "react"

import { player } from "../lib/audio-runtime"

export type BarsMode = "mic" | "speaker" | "idle" | "flatline"

const BAR_COUNT       = 14
const MIN_BAR_HEIGHT  = 4
const MAX_BAR_HEIGHT  = 24
const FLAT_BAR_HEIGHT = 5
const FREQ_RANGE_HZ   = { low: 80, high: 3000 }

export function FrequencyBars({ mode }: { mode: BarsMode }) {
  const barsRef   = useRef<(HTMLDivElement | null)[]>([])
  const rafRef    = useRef<number>()
  const streamRef = useRef<MediaStream>()
  const ctxRef    = useRef<AudioContext>()

  useEffect(() => {
    const stop = () => {
      cancelAnimationFrame(rafRef.current!)
      barsRef.current.forEach(b => { if (b) b.style.height = `${MIN_BAR_HEIGHT}px` })
      streamRef.current?.getTracks().forEach(t => t.stop())
      streamRef.current = undefined
      ctxRef.current?.close().catch(() => {})
      ctxRef.current = undefined
    }

    const animate = (analyser: AnalyserNode) => {
      const data = new Uint8Array(analyser.frequencyBinCount)
      const smoothed = new Array(barsRef.current.length).fill(MIN_BAR_HEIGHT)
      const nyquist = analyser.context.sampleRate / 2
      const startBin = Math.floor((FREQ_RANGE_HZ.low  / nyquist) * analyser.frequencyBinCount)
      const endBin   = Math.floor((FREQ_RANGE_HZ.high / nyquist) * analyser.frequencyBinCount)
      const range = endBin - startBin

      const tick = () => {
        analyser.getByteFrequencyData(data)
        const step = Math.floor(range / smoothed.length)
        barsRef.current.forEach((bar, i) => {
          if (!bar) return
          let sum = 0
          for (let j = 0; j < step; j++) sum += data[startBin + i * step + j]
          const avg = sum / step
          const target = Math.max(MIN_BAR_HEIGHT, (avg / 255) * MAX_BAR_HEIGHT)
          smoothed[i] = smoothed[i] * 0.5 + target * 0.5
          bar.style.height = `${smoothed[i]}px`
        })
        rafRef.current = requestAnimationFrame(tick)
      }
      tick()
    }

    if (mode === "idle" || mode === "flatline") { stop(); return }

    if (mode === "speaker") {
      const analyser = player.getAnalyser()
      if (analyser) animate(analyser)
      return stop
    }

    // mic
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      streamRef.current = stream
      const ctx      = new AudioContext()
      ctxRef.current = ctx
      const source   = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      source.connect(analyser)
      animate(analyser)
    }).catch(console.error)

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
