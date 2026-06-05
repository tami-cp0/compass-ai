import { PcmPlayer } from "~/audio/pcm-player"

// Shared 24 kHz PCM player. Consumed by both the session message handler
// (incoming audio chunks from Gemini) and the speaker visualisation
// (analyser node for the frequency bars).
export const player = new PcmPlayer(24000)
