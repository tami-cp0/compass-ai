class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]?.[0]
    if (input?.length) {
      this.port.postMessage(input.buffer, [input.buffer])
    }
    return true
  }
}

registerProcessor("pcm-capture-processor", PcmCaptureProcessor)
