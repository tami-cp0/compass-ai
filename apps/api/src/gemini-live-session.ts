import { GoogleGenAI, Modality, type FunctionDeclaration, type LiveServerMessage, type Session } from "@google/genai"
import { logger } from "./logger.js"
import { appendTurn, type ConversationHistory } from "./redis.js"
import type { ServerMessage } from "@compass-ai/types"

if (!process.env.GOOGLE_API_KEY) {
  throw new Error("GOOGLE_API_KEY environment variable is not set")
}

const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY })

const SYSTEM_PROMPT = `You are Compass, an AI voice assistant for a financial trading platform.
You help users navigate the platform, place trades, and research stocks.
You never go silent waiting for a tool result — acknowledge tool dispatch and keep talking.
When you receive a message prefixed with [automation context], absorb it silently as background
information. Do not read it aloud or acknowledge it unless the user asks what you are doing
or the task completes.`

const TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: "dispatch_research",
    description: "Start a background research task. Returns immediately — result will be injected when ready.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        name:        { type: "string", description: "Short label, e.g. 'DANGCEM Q3 earnings'" },
        description: { type: "string", description: "Full research question" },
      },
      required: ["name", "description"],
    },
  },
  {
    name: "dispatch_automation",
    description: "Start a background browser automation task. Returns immediately — result injected when done.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        name:        { type: "string", description: "Short label, e.g. 'Fill order form'" },
        description: { type: "string", description: "Full automation instruction" },
      },
      required: ["name", "description"],
    },
  },
  {
    name: "cancel_task",
    description: "Cancel a running background task by its taskId.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
      },
      required: ["taskId"],
    },
  },
]

export class GeminiLiveSession {
  private sessionId:  string
  private send:       (msg: ServerMessage) => void
  private history:    ConversationHistory
  private session:    Session | null = null

  // Tool call handlers — wired by TaskManager in Phase 6
  onDispatchResearch:  ((name: string, description: string) => Record<string, unknown>) | null = null
  onDispatchAutomation: ((name: string, description: string) => Record<string, unknown>) | null = null
  onCancelTask:         ((taskId: string) => Record<string, unknown>) | null = null

  constructor(sessionId: string, send: (msg: ServerMessage) => void, history: ConversationHistory) {
    this.sessionId = sessionId
    this.send      = send
    this.history   = history
  }

  async connect(): Promise<void> {
    const historyContext = this.history.summary || this.history.recentTurns.length > 0
      ? `\n\nConversation history:\n${this.history.summary}\n${this.history.recentTurns.map(t => `${t.role === "user" ? "User" : "Compass"}: ${t.content}`).join("\n")}`
      : ""

    this.session = await ai.live.connect({
      model: "gemini-2.0-flash-live-001",
      config: {
        systemInstruction: SYSTEM_PROMPT + historyContext,
        tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } },
        },
      },
      callbacks: {
        onopen:   () => logger.info("Gemini Live connected", { sessionId: this.sessionId }),
        onclose:  () => logger.info("Gemini Live closed",    { sessionId: this.sessionId }),
        onerror:  (e) => logger.error("Gemini Live error",  { sessionId: this.sessionId, error: String(e) }),
        onmessage: (msg: LiveServerMessage) => this.handleMessage(msg),
      },
    })
  }

  sendAudio(base64Pcm: string): void {
    if (!this.session) return
    this.session.sendRealtimeInput({
      audio: { data: base64Pcm, mimeType: "audio/pcm;rate=16000" },
    })
  }

  injectContent(text: string): void {
    if (!this.session) return
    this.session.sendClientContent({
      turns: [{ role: "user", parts: [{ text }] }],
      turnComplete: false,
    })
  }

  close(): void {
    this.session?.close()
    this.session = null
  }

  private handleMessage(msg: LiveServerMessage): void {
    // Audio output — stream back to extension
    const audioPart = msg.serverContent?.modelTurn?.parts?.find(p => p.inlineData?.mimeType?.startsWith("audio/"))
    if (audioPart?.inlineData) {
      this.send({
        type:     "audio_chunk",
        sessionId: this.sessionId,
        data:      audioPart.inlineData.data ?? "",
        mimeType:  "audio/pcm",
      })
    }

    // Transcript — write user speech to Redis
    const inputTranscript = msg.serverContent?.inputTranscription
    if (inputTranscript?.text) {
      appendTurn(this.sessionId, { role: "user", content: inputTranscript.text }).catch(
        (err: unknown) => logger.error("Redis appendTurn failed", { sessionId: this.sessionId, error: String(err) })
      )
    }

    // Transcript — write model speech to Redis on turn complete
    const outputTranscript = msg.serverContent?.outputTranscription
    if (outputTranscript?.text && msg.serverContent?.turnComplete) {
      appendTurn(this.sessionId, { role: "model", content: outputTranscript.text }).catch(
        (err: unknown) => logger.error("Redis appendTurn failed", { sessionId: this.sessionId, error: String(err) })
      )
    }

    // Tool calls — handle synchronously, respond immediately
    const toolCall = msg.toolCall
    if (!toolCall?.functionCalls?.length) return

    const responses: Array<{ id: string; name: string; response: Record<string, unknown> }> = []

    for (const call of toolCall.functionCalls) {
      const args = call.args as Record<string, string>
      let result: Record<string, unknown>

      if (call.name === "dispatch_research" && this.onDispatchResearch) {
        result = this.onDispatchResearch(args.name, args.description)
      } else if (call.name === "dispatch_automation" && this.onDispatchAutomation) {
        result = this.onDispatchAutomation(args.name, args.description)
      } else if (call.name === "cancel_task" && this.onCancelTask) {
        result = this.onCancelTask(args.taskId)
      } else {
        // Stub response — TaskManager not wired yet (Phase 6+)
        result = { status: "acknowledged", note: "Tool handler not yet wired" }
      }

      responses.push({ id: call.id ?? "", name: call.name ?? "", response: result })
      logger.info("Tool call handled", { sessionId: this.sessionId, tool: call.name, result })
    }

    this.session?.sendToolResponse({ functionResponses: responses })
  }
}
