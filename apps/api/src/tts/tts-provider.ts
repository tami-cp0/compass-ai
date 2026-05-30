export interface TTSProvider {
  synthesize(text: string): Promise<Buffer>
}
