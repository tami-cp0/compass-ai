import type { ExtensionMessage, ServerMessage } from "@compass-ai/types"
import cssText from "data-text:~/styles/globals.css"
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

// ── Compass SVG inlined to work inside Shadow DOM ────────────────────────────
const CompassIcon = ({ className }: { className?: string }) => (
  <svg fill="#ffffff" version="1.1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 49.978 49.978" className={className}>
<g>
	<g>
		<path d="M45.578,24.516l-4.286-0.635c-0.193-3.89-1.81-7.405-4.356-10.029l4.039-4.038l-0.279-0.28l-4.037,4.036
			c-2.713-2.656-6.392-4.318-10.453-4.422l-0.568-3.837v3.825l0,0V5.311l-0.57,3.854c-3.899,0.187-7.425,1.804-10.055,4.355
			l-4.03-3.986l-0.301,0.301l4.028,3.985c-2.621,2.685-4.267,6.312-4.399,10.319l-3.703,0.548l3.705,0.549
			c0.147,3.952,1.769,7.529,4.342,10.192l-3.975,3.953l0.301,0.301l3.972-3.949c2.674,2.621,6.29,4.271,10.287,4.418l0.567,3.84
			v-3.812l0,0v3.812l0.567-3.84c3.977-0.146,7.574-1.781,10.244-4.379l4.055,4.053l0.301-0.301L36.92,35.47
			c2.615-2.688,4.257-6.313,4.385-10.321L45.578,24.516z M21.929,22.418l-4.201,0.622c0.285-1.426,0.94-2.709,1.856-3.768
			L21.929,22.418z M20.49,18.375c0.987-0.837,2.166-1.439,3.469-1.74l-0.565,3.815L20.49,18.375z M24.095,15.716
			c-0.213,0.04-0.425,0.086-0.632,0.142l-0.298-1.691c0.388-0.098,0.788-0.16,1.191-0.212L24.095,15.716z M23.256,15.91
			c-0.647,0.188-1.265,0.444-1.845,0.765l-0.822-1.502c0.74-0.409,1.537-0.726,2.37-0.953L23.256,15.91z M21.229,16.784
			c-0.525,0.307-1.003,0.679-1.455,1.079l-1.43-1.021c0.623-0.596,1.312-1.123,2.063-1.558L21.229,16.784z M19.061,18.571
			c-0.427,0.473-0.819,0.979-1.142,1.534l-1.368-1.04c0.417-0.688,0.917-1.313,1.47-1.89L19.061,18.571z M17.809,20.289
			c-0.324,0.592-0.578,1.229-0.766,1.89l-1.657-0.421c0.246-0.889,0.602-1.729,1.055-2.509L17.809,20.289z M16.991,22.386
			c-0.067,0.258-0.111,0.521-0.155,0.786l-1.77,0.262c0.059-0.5,0.144-0.991,0.266-1.469L16.991,22.386z M22.858,22.712l1.117,0.776
			l0.001,0.024c-0.126,0.229-0.215,0.479-0.257,0.746H12.414L22.858,22.712z M19.427,29.845c-0.819-1.003-1.4-2.194-1.675-3.508
			l3.782,0.562L19.427,29.845z M23.504,28.432l0.634,4.282c-1.46-0.304-2.771-0.99-3.838-1.952L23.504,28.432z M16.847,26.203
			c0.048,0.297,0.105,0.591,0.185,0.877l-1.692,0.287c-0.12-0.463-0.202-0.941-0.264-1.426L16.847,26.203z M17.085,27.287
			c0.213,0.703,0.514,1.365,0.881,1.986l-1.553,0.737c-0.436-0.76-0.778-1.575-1.021-2.437L17.085,27.287z M18.076,29.457
			c0.247,0.395,0.532,0.761,0.833,1.111l-1.017,1.422c-0.512-0.553-0.979-1.146-1.369-1.795L18.076,29.457z M19.585,31.279
			c0.482,0.453,1.008,0.861,1.581,1.203l-0.948,1.424c-0.744-0.451-1.428-0.992-2.041-1.603L19.585,31.279z M21.348,32.594
			c0.611,0.346,1.267,0.618,1.955,0.814l-0.44,1.652c-0.871-0.246-1.695-0.599-2.462-1.043L21.348,32.594z M23.51,33.463
			c0.249,0.064,0.505,0.105,0.761,0.15l0.262,1.771c-0.498-0.062-0.988-0.146-1.463-0.271L23.51,33.463z M23.838,27.775l0.082-0.162
			l0.688-0.989l0.308-0.019c0.147,0.076,0.303,0.135,0.465,0.18l-0.001,11.4L23.838,27.775z M24.537,24.6
			c0-0.781,0.637-1.417,1.42-1.417c0.781,0,1.416,0.636,1.416,1.417c0,0.783-0.635,1.42-1.416,1.42
			C25.174,26.02,24.537,25.383,24.537,24.6z M29.871,26.842l4.021-0.596c-0.271,1.379-0.884,2.632-1.751,3.672L29.871,26.842z
			 M31.218,30.874c-0.901,0.784-1.968,1.381-3.147,1.718l-0.033,0.007v0.003c-0.182,0.051-0.375,0.075-0.562,0.113l0.613-4.143
			l0.05,0.101L31.218,30.874z M27.97,21.086l-0.671-4.536c1.523,0.281,2.889,0.985,3.996,1.979L27.97,21.086z M32.057,19.31
			c0.842,0.983,1.45,2.161,1.756,3.463l-3.826-0.566L32.057,19.31z M34.727,22.908c-0.027-0.136-0.043-0.275-0.076-0.41l1.684-0.324
			c0.076,0.326,0.129,0.661,0.173,0.998L34.727,22.908z M34.598,22.291c-0.205-0.756-0.497-1.473-0.878-2.137l1.524-0.783
			c0.453,0.807,0.801,1.678,1.035,2.596L34.598,22.291z M33.611,19.972c-0.299-0.496-0.658-0.95-1.041-1.379l1.02-1.427
			c0.589,0.611,1.111,1.286,1.545,2.023L33.611,19.972z M31.988,17.995c-0.483-0.451-1.008-0.858-1.582-1.196l0.976-1.408
			c0.722,0.437,1.382,0.961,1.981,1.548L31.988,17.995z M30.223,16.688c-0.578-0.321-1.195-0.581-1.843-0.771l0.569-1.619
			c0.793,0.241,1.545,0.576,2.248,0.982L30.223,16.688z M28.174,15.862c-0.327-0.088-0.665-0.146-1.005-0.199l-0.261-1.765
			c0.627,0.066,1.242,0.177,1.834,0.344L28.174,15.862z M27.609,21.562l-0.688,0.987c-0.264-0.124-0.555-0.195-0.859-0.208V11.117
			L27.609,21.562z M27.343,33.615c0.287-0.047,0.571-0.102,0.849-0.178l0.313,1.687c-0.462,0.118-0.94,0.2-1.423,0.261
			L27.343,33.615z M28.398,33.387c0.696-0.208,1.354-0.5,1.971-0.857l0.759,1.541c-0.757,0.429-1.563,0.764-2.416,1.002
			L28.398,33.387z M30.552,32.419c0.491-0.302,0.94-0.66,1.364-1.046l1.43,1.021c-0.613,0.598-1.296,1.125-2.038,1.564
			L30.552,32.419z M32.656,30.615c0.344-0.396,0.666-0.809,0.938-1.258l1.39,1.006c-0.373,0.598-0.813,1.144-1.291,1.654
			L32.656,30.615z M33.708,29.175c0.388-0.676,0.688-1.407,0.895-2.177l1.632,0.521c-0.261,0.946-0.646,1.838-1.138,2.661
			L33.708,29.175z M34.656,26.791c0.053-0.221,0.086-0.449,0.125-0.678l1.75-0.258c-0.054,0.494-0.125,0.984-0.246,1.457
			L34.656,26.791z M29.328,26.488l-1.115-0.774l-0.039-0.657c0.008-0.038,0.021-0.075,0.025-0.113h11.414
			c0,0.008-0.002,0.016-0.002,0.024L29.328,26.488z M39.576,23.626l-2.631-0.39c-0.314-2.485-1.436-4.719-3.102-6.426l0.387-0.539
			l-0.519,0.398c-1.8-1.781-4.201-2.952-6.867-3.199l-0.386-2.607C33.434,11.191,39.062,16.7,39.576,23.626z M25.636,10.839v3.405
			V10.839L25.636,10.839z M24.811,10.881l-0.391,2.638c-0.45,0.053-0.896,0.12-1.33,0.228l-0.001-0.008l-0.21,0.037l0.005,0.024
			c-1.869,0.504-3.542,1.482-4.894,2.789l-0.872-0.623l0.634,0.851c-1.723,1.766-2.864,4.096-3.13,6.684l-2.599,0.385
			C12.407,16.953,17.909,11.376,24.811,10.881z M12.028,25.489l2.619,0.388c0.175,1.588,0.664,3.082,1.43,4.402l0.051,0.104
			l0.012-0.005c0.424,0.714,0.931,1.37,1.496,1.972l-0.517,0.723l0.711-0.517c1.77,1.789,4.133,2.979,6.768,3.265l0.386,2.611
			C18.025,38.021,12.447,32.447,12.028,25.489z M25.807,38.475v-3.418V38.475L25.807,38.475z M26.63,38.433l0.388-2.618
			c2.592-0.279,4.922-1.432,6.68-3.168l0.973,0.694l-0.715-0.968c1.664-1.756,2.765-4.043,3.021-6.584l2.613-0.387
			C39.211,32.402,33.617,38.018,26.63,38.433z"/>
	</g>
</g>
</svg>
)

// ── Frequency bars driven by mic OR Gemini output ────────────────────────────
type BarsMode = "mic" | "speaker" | "idle"

function FrequencyBars({ mode }: { mode: BarsMode }) {
  const barsRef   = useRef<(HTMLDivElement | null)[]>([])
  const rafRef    = useRef<number>()
  const streamRef = useRef<MediaStream>()
  const ctxRef    = useRef<AudioContext>()

  useEffect(() => {
    const stop = () => {
      cancelAnimationFrame(rafRef.current!)
      barsRef.current.forEach(b => { if (b) b.style.height = "4px" })
      streamRef.current?.getTracks().forEach(t => t.stop())
      streamRef.current = undefined
      ctxRef.current?.close().catch(() => {})
      ctxRef.current = undefined
    }

    const animate = (analyser: AnalyserNode) => {
      const data = new Uint8Array(analyser.frequencyBinCount)
      const smoothed = new Array(barsRef.current.length).fill(4)
      const nyquist = analyser.context.sampleRate / 2
      const startBin = Math.floor((80 / nyquist) * analyser.frequencyBinCount)
      const endBin   = Math.floor((3000 / nyquist) * analyser.frequencyBinCount)
      const range = endBin - startBin

      const tick = () => {
        analyser.getByteFrequencyData(data)
        const step = Math.floor(range / smoothed.length)
        barsRef.current.forEach((bar, i) => {
          if (!bar) return
          let sum = 0
          for (let j = 0; j < step; j++) sum += data[startBin + i * step + j]
          const avg = sum / step
          const target = Math.max(4, (avg / 255) * 24)
          smoothed[i] = smoothed[i] * 0.5 + target * 0.5
          bar.style.height = `${smoothed[i]}px`
        })
        rafRef.current = requestAnimationFrame(tick)
      }
      tick()
    }

    if (mode === "idle") { stop(); return }

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

  return (
    <div className="flex items-center gap-[3px] h-8 relative z-10">
      {Array.from({ length: 14 }).map((_, i) => (
        <div
          key={i}
          ref={el => { barsRef.current[i] = el }}
          className="w-[3px] bg-white rounded-full"
          style={{ height: "4px", transition: "height 75ms ease" }}
        />
      ))}
    </div>
  )
}

// ── Pill ─────────────────────────────────────────────────────────────────────
const Pill = () => {
  const [active, setActive]         = useState(false)
  const [showActive, setShowActive] = useState(false)
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [isAutomationRunning, setIsAutomationRunning] = useState(false)
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(null)
  const captureRef = useRef<PcmCapture | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const introRef = useRef<{ target: number; value: number; lastT: number }>({ target: 0, value: 0, lastT: 0 })
  const startBorderRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    const STYLE_ID   = "compass-viewport-border-style"
    const OVERLAY_ID = "compass-viewport-border"

    let cleanup: (() => void) | null = null
    try {
    const style = document.createElement("style")
    style.id = STYLE_ID
    style.textContent = `
      #${OVERLAY_ID} {
        position: fixed;
        inset: 0;
        pointer-events: none;
        z-index: 2147483646;
        opacity: 0;
        animation: compass-fade-in 700ms ease-out forwards;
      }
      #${OVERLAY_ID} canvas { display: block; width: 100%; height: 100%; }
      @keyframes compass-fade-in { to { opacity: 1; } }
    `
    document.head.appendChild(style)

    const overlay = document.createElement("div")
    overlay.id = OVERLAY_ID

    const canvas = document.createElement("canvas")
    overlay.appendChild(canvas)
    document.documentElement.appendChild(overlay)

    const gl = canvas.getContext("webgl", {
      premultipliedAlpha: true,
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: false
    })

    if (!gl) {
      // No WebGL — bail silently
      return () => { overlay.remove(); style.remove() }
    }

    const vertSrc = `
      attribute vec2 a_pos;
      varying vec2 v_uv;
      void main() {
        v_uv = a_pos * 0.5 + 0.5;
        gl_Position = vec4(a_pos, 0.0, 1.0);
      }
    `

    // Fragment shader: rounded-rect SDF border + flowing simplex noise + gemini gradient
    const fragSrc = `
      precision highp float;
      varying vec2 v_uv;
      uniform vec2  u_res;
      uniform float u_time;
      uniform float u_dpr;
      uniform float u_intro;

      // ---- simplex noise (Ashima) ----
      vec3 mod289(vec3 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
      vec2 mod289(vec2 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
      vec3 permute(vec3 x){ return mod289(((x*34.0)+1.0)*x); }
      float snoise(vec2 v){
        const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                           -0.577350269189626, 0.024390243902439);
        vec2 i  = floor(v + dot(v, C.yy));
        vec2 x0 = v -   i + dot(i, C.xx);
        vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
        vec4 x12 = x0.xyxy + C.xxzz;
        x12.xy -= i1;
        i = mod289(i);
        vec3 p = permute( permute( i.y + vec3(0.0, i1.y, 1.0))
                                 + i.x + vec3(0.0, i1.x, 1.0));
        vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
        m = m*m; m = m*m;
        vec3 x = 2.0 * fract(p * C.www) - 1.0;
        vec3 h = abs(x) - 0.5;
        vec3 ox = floor(x + 0.5);
        vec3 a0 = x - ox;
        m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
        vec3 g;
        g.x  = a0.x  * x0.x  + h.x  * x0.y;
        g.yz = a0.yz * x12.xz + h.yz * x12.yw;
        return 130.0 * dot(m, g);
      }
      float fbm(vec2 p){
        float v = 0.0; float a = 0.5;
        for (int i = 0; i < 4; i++) {
          v += a * snoise(p);
          p *= 2.02; a *= 0.5;
        }
        return v;
      }

      // Signed distance to a rounded rectangle centered at origin
      float sdRoundRect(vec2 p, vec2 b, float r){
        vec2 q = abs(p) - b + r;
        return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
      }

      // Signed distance to a sharp-cornered rectangle centered at origin
      float sdRect(vec2 p, vec2 b){
        vec2 q = abs(p) - b;
        return min(max(q.x, q.y), 0.0) + length(max(q, 0.0));
      }

      // Teal / ice cyan / soft periwinkle / soft mint palette
      vec3 gemini(float t){
        t = fract(t);
        vec3 c0 = vec3(0.078, 0.722, 0.651); // #14B8A6 teal (anchor)
        vec3 c1 = vec3(0.404, 0.910, 0.976); // #67E8F9 ice cyan
        vec3 c2 = vec3(0.647, 0.706, 0.988); // #A5B4FC soft periwinkle
        vec3 c3 = vec3(0.525, 0.937, 0.675); // #86EFAC soft mint
        float seg = t * 4.0;
        int idx = int(floor(seg));
        float f = fract(seg);
        f = smoothstep(0.0, 1.0, f);
        vec3 a, b;
        if      (idx == 0) { a = c0; b = c1; }
        else if (idx == 1) { a = c1; b = c2; }
        else if (idx == 2) { a = c2; b = c3; }
        else               { a = c3; b = c0; }
        return mix(a, b, f);
      }

      void main(){
        vec2 frag = v_uv * u_res;
        vec2 center = u_res * 0.5;
        vec2 p = frag - center;

        // ── Layer 1: sharp rectangle, flush with viewport, 90° corners ──
        vec2 outerHalf = u_res * 0.5;
        float dOuter   = sdRect(p, outerHalf);   // 0 at edge, negative inside

        // Perimeter coordinate s in [0,1] — drives flow + gradient
        vec2 q = p / max(outerHalf, vec2(1.0));
        float ang = atan(q.y, q.x);
        float s = fract(ang / 6.2831853 + 0.25);

        // Flow field traveling along the border — multiple scales for visible waviness
        float flow1 = fbm(vec2(s * 8.0  - u_time * 0.25, u_time * 0.12));
        float flow2 = fbm(vec2(s * 18.0 + u_time * 0.45, u_time * 0.08 + 4.7));
        float flow3 = fbm(vec2(s * 32.0 - u_time * 0.65, u_time * 0.15 + 9.1));
        // Combined wave: big swells (flow1) + medium ripples (flow2) + fine chop (flow3)
        float wave = flow1 * 0.65 + flow2 * 0.28 + flow3 * 0.12;
        float waveNorm = 0.5 + 0.5 * wave; // 0..1

        // Single continuous falloff from the rectangle edge inward.
        // The wave modulates the reach per perimeter position so the fade
        // itself looks fluid, with no stacked layers and no visible seam.
        float outerAA = 1.0 * u_dpr;
        float outerMask = smoothstep(outerAA, -outerAA, dOuter);

        float depth = -dOuter;

        // Intro/outro: band swells from zero thickness to full reach, evenly around the perimeter.
        float swell = u_intro;

        float fullReach = mix(16.0, 48.0, waveNorm) * u_dpr + flow3 * 2.0 * u_dpr;
        float reach     = fullReach * swell;

        float falloff = (reach > 0.0) ? (1.0 - smoothstep(0.0, reach, depth)) : 0.0;
        falloff = pow(falloff, 1.4);

        float band = outerMask * falloff;

        // Color walks the perimeter, drifts in time
        float hue = s + u_time * 0.045 + flow1 * 0.06;
        vec3 col = gemini(hue);

        // Subtle brightness pulse
        float pulse = 0.85 + 0.30 * (0.5 + 0.5 * sin(u_time * 1.4 + s * 12.566));
        col *= pulse;

        float alpha = clamp(band * swell, 0.0, 1.0);
        gl_FragColor = vec4(col * alpha, alpha);
      }
    `

    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!
      gl.shaderSource(sh, src)
      gl.compileShader(sh)
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.error("[compass] shader compile failed:", gl.getShaderInfoLog(sh))
        gl.deleteShader(sh)
        return null
      }
      return sh
    }

    const vs = compile(gl.VERTEX_SHADER, vertSrc)
    const fs = compile(gl.FRAGMENT_SHADER, fragSrc)
    if (!vs || !fs) {
      return () => { overlay.remove(); style.remove() }
    }

    const prog = gl.createProgram()!
    gl.attachShader(prog, vs)
    gl.attachShader(prog, fs)
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error("[compass] link failed:", gl.getProgramInfoLog(prog))
      return () => { overlay.remove(); style.remove() }
    }
    gl.useProgram(prog)

    // Fullscreen quad
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,   1, -1,  -1,  1,
      -1,  1,   1, -1,   1,  1,
    ]), gl.STATIC_DRAW)
    const aPos = gl.getAttribLocation(prog, "a_pos")
    gl.enableVertexAttribArray(aPos)
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)

    const uRes   = gl.getUniformLocation(prog, "u_res")
    const uTime  = gl.getUniformLocation(prog, "u_time")
    const uDpr   = gl.getUniformLocation(prog, "u_dpr")
    const uIntro = gl.getUniformLocation(prog, "u_intro")

    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA) // premultiplied alpha

    const resize = () => {
      const dpr = window.devicePixelRatio || 1
      const w = Math.floor(window.innerWidth  * dpr)
      const h = Math.floor(window.innerHeight * dpr)
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
      gl.viewport(0, 0, w, h)
      gl.uniform2f(uRes, w, h)
      gl.uniform1f(uDpr, dpr)
    }
    resize()
    window.addEventListener("resize", resize)

    let raf = 0
    let running = false
    let startTime = performance.now()
    let lastT = startTime
    const introState = introRef.current

    // ease-out cubic
    const ease = (x: number) => 1.0 - Math.pow(1.0 - x, 3.0)
    const INTRO_DURATION_MS = 900

    const clearCanvas = () => {
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
    }

    const frame = () => {
      const now = performance.now()
      const t = (now - startTime) / 1000
      gl.uniform1f(uTime, t)

      const dt = now - lastT
      lastT = now
      const step = dt / INTRO_DURATION_MS
      const dir = Math.sign(introState.target - introState.value)
      if (dir !== 0) {
        introState.value = Math.max(0, Math.min(1, introState.value + step * dir))
      }
      gl.uniform1f(uIntro, ease(introState.value))

      clearCanvas()
      gl.drawArrays(gl.TRIANGLES, 0, 6)

      // Stop the loop entirely once we've fully settled into the off state.
      if (introState.target === 0 && introState.value <= 0.0001) {
        introState.value = 0
        running = false
        // Final clear so nothing lingers on the canvas
        clearCanvas()
        return
      }
      raf = requestAnimationFrame(frame)
    }

    const startLoop = () => {
      if (running) return
      running = true
      // Reset the clock so the wave field always starts from the same phase
      // on activation. Without this, u_time keeps advancing between sessions
      // and the wave "jumps" mid-intro.
      startTime = performance.now()
      lastT = startTime
      raf = requestAnimationFrame(frame)
    }
    startBorderRef.current = startLoop

    // Idle on mount — no GPU work until user activates
    clearCanvas()

    cleanup = () => {
      cancelAnimationFrame(raf)
      startBorderRef.current = null
      window.removeEventListener("resize", resize)
      gl.deleteBuffer(buf)
      gl.deleteProgram(prog)
      gl.deleteShader(vs)
      gl.deleteShader(fs)
      overlay.remove()
      style.remove()
    }
    } catch (err) {
      console.error("[compass] viewport border init failed:", err)
      document.getElementById(OVERLAY_ID)?.remove()
      document.getElementById(STYLE_ID)?.remove()
    }

    return () => { cleanup?.() }
  }, [])

  useEffect(() => {
    if (!active) setShowActive(false)
    introRef.current.target = active ? 1 : 0
    // Wake the WebGL loop so it can play either the intro or the outro;
    // it self-stops once the outro settles back to 0.
    startBorderRef.current?.()
  }, [active])

  useEffect(() => {
    const onMessage = (msg: ServerMessage) => {
      if (msg.type === "audio_chunk") {
        player.resume()
        player.play(msg.data)
        setIsSpeaking(true)
        return false
      }
      if (msg.type === "action") {
        setIsAutomationRunning(true)
        return false
      }
      if (msg.type === "user_action_required") {
        setConfirmation({ actionId: msg.actionId, taskId: msg.taskId, description: msg.description })
        return false
      }
      if (msg.type === "automation_end") {
        setIsAutomationRunning(false)
        setConfirmation(null)
        return false
      }
      return false
    }
    chrome.runtime.onMessage.addListener(onMessage)
    return () => chrome.runtime.onMessage.removeListener(onMessage)
  }, [])

  const startSession = useCallback(async () => {
    chrome.runtime.sendMessage({ type: "session_start" })
    const capture = new PcmCapture((base64Pcm: string) => {
      setIsSpeaking(false)
      chrome.runtime.sendMessage({ type: "audio_chunk", data: base64Pcm, mimeType: "audio/pcm" } as OutboundExtensionMessage)
    })
    await capture.start()
    captureRef.current = capture
    setActive(true)
  }, [])

  const stopSession = useCallback(() => {
    captureRef.current?.stop()
    captureRef.current = null
    chrome.runtime.sendMessage({ type: "session_end" })
    setActive(false)
    setIsSpeaking(false)
  }, [])

  const toggle = useCallback(() => {
    const btn = btnRef.current
    if (btn) {
      btn.classList.remove("bouncing")
      void btn.offsetWidth
      btn.classList.add("bouncing")
      btn.addEventListener("animationend", () => {
        btn.classList.remove("bouncing")
      }, { once: true })
    }
    if (active) stopSession()
    else startSession().catch(console.error)
  }, [active, startSession, stopSession])

  return (
    <div className="fixed top-6 left-1/2 -translate-x-1/2">
      <button
        ref={btnRef}
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
