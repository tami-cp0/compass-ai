import workletUrl from "url:./pcm-capture-worklet.js"

type OnChunk = (base64Pcm: string) => void

export class PcmCapture {
  private audioCtx: AudioContext | null = null
  private stream:   MediaStream | null  = null
  private onChunk:  OnChunk

  constructor(onChunk: OnChunk) {
    this.onChunk = onChunk
  }

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount:     1,
        sampleRate:       16000,
        echoCancellation: true,
        noiseSuppression: true,
      },
    })

    this.audioCtx = new AudioContext({ sampleRate: 16000 })

    await this.audioCtx.audioWorklet.addModule(workletUrl)

    const source    = this.audioCtx.createMediaStreamSource(this.stream)
    const worklet   = new AudioWorkletNode(this.audioCtx, "pcm-capture-processor")

    worklet.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      const float32 = new Float32Array(e.data)
      const int16   = new Int16Array(float32.length)
      for (let i = 0; i < float32.length; i++) {
        int16[i] = Math.max(-32768, Math.min(32767, float32[i] * 32768))
      }
      let binary = ""
      const bytes = new Uint8Array(int16.buffer)
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
      this.onChunk(btoa(binary))
    }

    source.connect(worklet)
    worklet.connect(this.audioCtx.destination)
  }

  stop(): void {
    this.stream?.getTracks().forEach(t => t.stop())
    this.audioCtx?.close()
    this.stream   = null
    this.audioCtx = null
  }
}
