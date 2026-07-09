// ─────────────────────────────────────────────────────────────────────────────
// Viewport edge-glow: a WebGL-rendered animated border that swells in when
// activated and retracts when deactivated. The render loop self-stops while
// idle so the GPU is untouched in the off state.
// ─────────────────────────────────────────────────────────────────────────────

const STYLE_ID   = "compass-viewport-border-style"
const OVERLAY_ID = "compass-viewport-border"

const VERT_SRC = `
  attribute vec2 a_pos;
  varying vec2 v_uv;
  void main() {
    v_uv = a_pos * 0.5 + 0.5;
    gl_Position = vec4(a_pos, 0.0, 1.0);
  }
`

const FRAG_SRC = `
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
    for (int i = 0; i < 3; i++) {
      v += a * snoise(p);
      p *= 2.02; a *= 0.5;
    }
    return v;
  }

  float sdRect(vec2 p, vec2 b){
    vec2 q = abs(p) - b;
    return min(max(q.x, q.y), 0.0) + length(max(q, 0.0));
  }

  // Teal / ice cyan / soft periwinkle / soft mint palette
  vec3 palette(float t){
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

    vec2 outerHalf = u_res * 0.5;
    float dOuter   = sdRect(p, outerHalf);

    vec2 q = p / max(outerHalf, vec2(1.0));
    float ang = atan(q.y, q.x);
    // Perimeter coordinate: 0 at bottom-center, 0.5 at top-center (the pill).
    float s = fract(ang / 6.2831853 + 0.25);

    // Traveling sine waves around the perimeter — smooth, continuous flow.
    // Three layers at different frequencies/speeds keep it from looking too mechanical.
    float TAU = 6.2831853;
    float w1 = sin(s * TAU *  3.0 - u_time * 0.7);   // 3 crests, slow
    float w2 = sin(s * TAU *  5.0 + u_time * 1.1);   // 5 crests, faster, opposite direction
    float w3 = sin(s * TAU *  8.0 - u_time * 0.4);   // 8 crests, slowest, fine modulation
    float wave = w1 * 0.55 + w2 * 0.30 + w3 * 0.15;
    float waveNorm = 0.5 + 0.5 * wave;
    float flow1 = w1; // re-used by the color hue drift below

    float outerAA = 1.0 * u_dpr;
    float outerMask = smoothstep(outerAA, -outerAA, dOuter);

    float depth = -dOuter;

    // Ignition sweep: light spreads from the top-center (cast by the pill)
    // down both sides and meets at the bottom; retraction runs in reverse,
    // draining back into the pill. u_intro drives the sweep front.
    float dTop = abs(s - 0.5);            // 0 at top-center → 0.5 at bottom
    float FEATHER = 0.07;
    float front = u_intro * (0.5 + FEATHER);
    float local = 1.0 - smoothstep(front - FEATHER, front, dTop);

    // Corner blooms: light pools in the corners, each breathing gently out
    // of phase with its neighbours.
    float corner = pow(abs(q.x * q.y), 2.0);
    float ph = q.x > 0.0 ? (q.y > 0.0 ? 0.0 : 1.6) : (q.y > 0.0 ? 3.1 : 4.7);
    float breath = 0.5 + 0.5 * sin(u_time * 0.45 + ph);
    float cornerBoost = corner * (0.35 + 0.45 * breath);

    // One light field at two falloff depths: a tight body band and a wide,
    // faint wash beneath it — light bleeding into the page, not painted on.
    float reach1 = mix(16.0, 48.0, waveNorm) * (1.0 + cornerBoost * 0.5) * u_dpr * local;
    float band1  = (reach1 > 0.0) ? pow(1.0 - smoothstep(0.0, reach1, depth), 1.4) : 0.0;

    float reach2 = 95.0 * (1.0 + cornerBoost * 0.6) * u_dpr * local;
    float band2  = (reach2 > 0.0) ? pow(1.0 - smoothstep(0.0, reach2, depth), 2.4) : 0.0;

    float intensity = (band1 + band2 * 0.35) * (1.0 + cornerBoost);

    // Organic grain: slow drifting noise inside the light so the field feels
    // gaseous rather than mathematically clean.
    float n = fbm(p * 0.006 / u_dpr + vec2(u_time * 0.12, -u_time * 0.09));
    intensity *= 0.82 + 0.36 * n;

    // One slow global breath (replaces the old fast per-arc shimmer).
    intensity *= 0.90 + 0.10 * sin(u_time * 0.5);

    // Bright leading tip on the sweep front while igniting/retracting;
    // dissolves completely once the field is at rest.
    float tip = exp(-abs(dTop - front) * 40.0) * (1.0 - u_intro) * u_intro * 4.0;
    intensity += tip * band1;

    float hue = s + u_time * 0.045 + flow1 * 0.06;
    vec3 col = palette(hue);

    float alpha = clamp(intensity * outerMask, 0.0, 1.0);
    gl_FragColor = vec4(col * alpha, alpha);
  }
`

export interface EdgeGlowHandle {
  setActive: (active: boolean) => void
  destroy:   () => void
}

export interface EdgeGlowOptions {
  /** Intro/outro duration in milliseconds. Default: 900. */
  durationMs?: number
}

export function createEdgeGlow(opts: EdgeGlowOptions = {}): EdgeGlowHandle {
  const DURATION_MS = opts.durationMs ?? 900

  const noop: EdgeGlowHandle = { setActive: () => {}, destroy: () => {} }

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
      premultipliedAlpha:    true,
      alpha:                 true,
      antialias:             true,
      preserveDrawingBuffer: false
    })
    if (!gl) {
      overlay.remove()
      style.remove()
      return noop
    }

    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)
      if (!sh) return null
      gl.shaderSource(sh, src)
      gl.compileShader(sh)
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.error("[edge-glow] shader compile failed:", gl.getShaderInfoLog(sh))
        gl.deleteShader(sh)
        return null
      }
      return sh
    }

    const vs = compile(gl.VERTEX_SHADER, VERT_SRC)
    const fs = compile(gl.FRAGMENT_SHADER, FRAG_SRC)
    if (!vs || !fs) {
      overlay.remove()
      style.remove()
      return noop
    }

    const prog = gl.createProgram()
    if (!prog) {
      overlay.remove()
      style.remove()
      return noop
    }
    gl.attachShader(prog, vs)
    gl.attachShader(prog, fs)
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error("[edge-glow] link failed:", gl.getProgramInfoLog(prog))
      overlay.remove()
      style.remove()
      return noop
    }
    gl.useProgram(prog)

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
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)

    const resize = () => {
      const dpr = window.devicePixelRatio || 1
      const w = Math.floor(window.innerWidth  * dpr)
      const h = Math.floor(window.innerHeight * dpr)
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width  = w
        canvas.height = h
      }
      gl.viewport(0, 0, w, h)
      gl.uniform2f(uRes, w, h)
      gl.uniform1f(uDpr, dpr)
    }
    resize()
    window.addEventListener("resize", resize)

    const clearCanvas = () => {
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
    }

    const ease = (x: number) => 1.0 - Math.pow(1.0 - x, 3.0)

    let raf      = 0
    let running  = false
    let target   = 0
    let value    = 0
    let startTime = performance.now()
    let lastT     = startTime

    const frame = () => {
      const now = performance.now()
      const t   = (now - startTime) / 1000
      gl.uniform1f(uTime, t)

      const dt   = now - lastT
      lastT      = now
      const step = dt / DURATION_MS
      const dir  = Math.sign(target - value)
      if (dir !== 0) {
        value = Math.max(0, Math.min(1, value + step * dir))
      }
      gl.uniform1f(uIntro, ease(value))

      clearCanvas()
      gl.drawArrays(gl.TRIANGLES, 0, 6)

      if (target === 0 && value <= 0.0001) {
        value   = 0
        running = false
        clearCanvas()
        return
      }
      raf = requestAnimationFrame(frame)
    }

    const startLoop = () => {
      if (running) return
      running   = true
      // Reset the clock so the wave field always starts from the same phase on activation
      startTime = performance.now()
      lastT     = startTime
      raf       = requestAnimationFrame(frame)
    }

    clearCanvas()

    return {
      setActive(active) {
        target = active ? 1 : 0
        startLoop()
      },
      destroy() {
        cancelAnimationFrame(raf)
        window.removeEventListener("resize", resize)
        gl.deleteBuffer(buf)
        gl.deleteProgram(prog)
        gl.deleteShader(vs)
        gl.deleteShader(fs)
        overlay.remove()
        style.remove()
      }
    }
  } catch (err) {
    console.error("[edge-glow] init failed:", err)
    document.getElementById(OVERLAY_ID)?.remove()
    document.getElementById(STYLE_ID)?.remove()
    return noop
  }
}
