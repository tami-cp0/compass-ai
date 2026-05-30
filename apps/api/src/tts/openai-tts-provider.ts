import OpenAI from "openai"
import type { TTSProvider } from "./tts-provider.js"

export class OpenAITTSProvider implements TTSProvider {
  private client: OpenAI

  constructor() {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY environment variable is not set")
    }
    this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  }

  async synthesize(text: string): Promise<Buffer> {
    const mp3 = await this.client.audio.speech.create({
      model: "tts-1",
      voice: "alloy",
      input: text,
    })
    return Buffer.from(await mp3.arrayBuffer())
  }
}
