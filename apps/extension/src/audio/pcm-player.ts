export class PcmPlayer {
  private audioCtx:  AudioContext | null = null
  private nextStart: number = 0
  private sampleRate: number

  constructor(sampleRate = 24000) {
    // Gemini Live outputs at 24kHz
    this.sampleRate = sampleRate
  }

  private getCtx(): AudioContext {
    if (!this.audioCtx) {
      this.audioCtx  = new AudioContext({ sampleRate: this.sampleRate })
      this.nextStart = this.audioCtx.currentTime
    }
    return this.audioCtx
  }

  play(base64Pcm: string): void {
    const ctx    = this.getCtx()
    const binary = atob(base64Pcm)
    const bytes  = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)

    const int16       = new Int16Array(bytes.buffer)
    const float32     = new Float32Array(int16.length)
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768

    const buffer = ctx.createBuffer(1, float32.length, this.sampleRate)
    buffer.copyToChannel(float32, 0)

    const source  = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)

    const startAt = Math.max(ctx.currentTime, this.nextStart)
    source.start(startAt)
    this.nextStart = startAt + buffer.duration
  }

  resume(): void {
    this.audioCtx?.resume()
  }

  stop(): void {
    this.audioCtx?.close()
    this.audioCtx  = null
    this.nextStart = 0
  }
}
