type OnChunk = (base64Pcm: string) => void

export class PcmCapture {
  private mediaRecorder: MediaRecorder | null = null
  private audioCtx:      AudioContext | null  = null
  private onChunk:       OnChunk

  constructor(onChunk: OnChunk) {
    this.onChunk = onChunk
  }

  async start(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount:  1,
        sampleRate:    16000,
        echoCancellation: true,
        noiseSuppression: true,
      },
    })

    this.audioCtx = new AudioContext({ sampleRate: 16000 })
    const source  = this.audioCtx.createMediaStreamSource(stream)

    // ScriptProcessor gives us raw float32 PCM chunks (deprecated but universally supported in Chrome extensions)
    // AudioWorklet requires registering a separate worklet file, which is complex in Plasmo.
    const processor = this.audioCtx.createScriptProcessor(4096, 1, 1)
    processor.onaudioprocess = (e) => {
      const float32 = e.inputBuffer.getChannelData(0)
      const int16   = new Int16Array(float32.length)
      for (let i = 0; i < float32.length; i++) {
        int16[i] = Math.max(-32768, Math.min(32767, float32[i] * 32768))
      }
      // Use a loop instead of spread to avoid stack overflow on large arrays
      let binary = ""
      const bytes = new Uint8Array(int16.buffer)
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
      const base64 = btoa(binary)
      this.onChunk(base64)
    }

    source.connect(processor)
    processor.connect(this.audioCtx.destination)

    this.mediaRecorder = new MediaRecorder(stream)
    this.mediaRecorder.start()
  }

  stop(): void {
    this.mediaRecorder?.stop()
    this.mediaRecorder?.stream.getTracks().forEach(t => t.stop())
    this.audioCtx?.close()
    this.mediaRecorder = null
    this.audioCtx      = null
  }
}
