export interface SpeechProvider {
    start(): void;
    stop(): void;
    onTranscript: ((text: string, isFinal: boolean) => void) | null;
}
//# sourceMappingURL=speech.d.ts.map