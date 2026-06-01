import { GoogleGenAI, Modality, type FunctionDeclaration, type LiveServerMessage, type Session } from "@google/genai"
import { logger } from "./logger.js"
import { appendTurn, type ConversationHistory } from "./redis.js"
import type { ServerMessage } from "@compass-ai/types"

if (!process.env.GEMINI_API_KEY) {
  throw new Error("GEMINI_API_KEY environment variable is not set")
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })

const SYSTEM_PROMPT = `You are Compass, an assistant.
You help users navigate the platform, place trades, and research stocks.
You never go silent waiting for a tool result — acknowledge tool dispatch and keep talking naturally based on context.
When you receive a message prefixed with [automation context], absorb it silently as background
information. Do not read it aloud or acknowledge it unless the user asks what you are doing
or the task completes.
When dispatching a research task, reconstruct the user's intent into a precise, keyword-dense research question. Include the ticker symbol, the specific time period, and all financial metrics or narrative themes the user mentioned or implied. Do not echo the user's words — synthesize their intent into the best possible search query.
Once you have dispatched a research task, the description is already submitted and cannot be changed — it is gone, it is running. Do not ask the user any follow-up questions about what they want to know or what aspect to focus on. There is nothing to clarify. The result will arrive on its own. Simply acknowledge briefly and keep the conversation going naturally.
When you receive a message prefixed with [research_result], that is your back office returning the data you requested. Deliver it like a colleague who just got a notification — transition naturally, start with the most important point, say them in plain conversational language, and invite the user's reaction, then proceed from there with the rest of the information if you think it is necessary. Do not list numbers robotically. Do not read out every metric. Talk like a person.`

const TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: "dispatch_research",
    description: "Start a background research task. Returns immediately — result will be injected when ready.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Short label identifying this research task. Example: \"DANGCEM Q3 2025 earnings\"",
        },
        description: {
          type: "string",
          description: "Precise, keyword-dense research question synthesized from the conversation. Include the ticker symbol, specific time period, and all financial metrics or narrative themes the user mentioned or implied. Example: \"DANGCEM Q3 2025 revenue, EBITDA margin, dividend declared, impact of naira devaluation on input costs\". Do not paraphrase the user — synthesize their intent into the best possible search query.",
        },
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
  {
    name: "request_screenshot",
    description: "Capture a screenshot of the user's current browser viewport. Use this when you need to see the page to understand its state, identify what is visible, or gather context before dispatching research or automation.",
    parametersJsonSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
]

export class GeminiLiveSession {
  private sessionId:  string
  private send:       (msg: ServerMessage) => void
  private history:    ConversationHistory
  private session:    Session | null = null
  private outputTranscriptBuffer = ""

  // Tool call handlers — wired by TaskManager in Phase 6
  onDispatchResearch:  ((name: string, description: string) => Record<string, unknown>) | null = null
  onDispatchAutomation: ((name: string, description: string) => Record<string, unknown>) | null = null
  onCancelTask:         ((taskId: string) => Record<string, unknown>) | null = null
  onRequestScreenshot: (() => Promise<string>) | null = null

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
      model: "gemini-3.1-flash-live-preview",
      config: {
        systemInstruction: SYSTEM_PROMPT + historyContext,
        tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: "Gacrux" } },
        },
      },
      callbacks: {
        onopen:   () => logger.info("Gemini Live connected", { sessionId: this.sessionId }),
        onclose:  (e) => logger.info("Gemini Live closed",    { sessionId: this.sessionId, code: (e as {code?:number;reason?:string})?.code, reason: (e as {code?:number;reason?:string})?.reason }),
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

  async close(): Promise<void> {
    this.session?.close()
    this.session = null
  }

  private async handleMessage(msg: LiveServerMessage): Promise<void> {
    // Audio output — stream back to extension
    const audioPart = msg.serverContent?.modelTurn?.parts?.find(p => p.inlineData?.mimeType?.startsWith("audio/"))
    if (audioPart?.inlineData) {
      this.send({
        type:      "audio_chunk",
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

    // Buffer incremental output transcription
    const outputTranscript = msg.serverContent?.outputTranscription
    if (outputTranscript?.text) {
      this.outputTranscriptBuffer += outputTranscript.text
    }

    // Flush buffered transcript to Redis on turn complete
    if (msg.serverContent?.turnComplete && this.outputTranscriptBuffer) {
      const text = this.outputTranscriptBuffer
      this.outputTranscriptBuffer = ""
      appendTurn(this.sessionId, { role: "model", content: text }).catch(
        (err: unknown) => logger.error("Redis appendTurn failed", { sessionId: this.sessionId, error: String(err) })
      )
    }

    // Tool calls — handle synchronously, respond immediately
    const toolCall = msg.toolCall
    if (!toolCall?.functionCalls?.length) return

    const responses: Array<{ id: string; name: string; response: Record<string, unknown> }> = []

    for (const call of toolCall.functionCalls) {
      if (!call.args) {
        responses.push({ id: call.id ?? "", name: call.name ?? "", response: { error: "missing args" } })
        continue
      }
      const args = call.args as Record<string, string>
      let result: Record<string, unknown>

      if (call.name === "dispatch_research" && this.onDispatchResearch) {
        result = this.onDispatchResearch(args.name, args.description)
      } else if (call.name === "dispatch_automation" && this.onDispatchAutomation) {
        result = this.onDispatchAutomation(args.name, args.description)
      } else if (call.name === "cancel_task" && this.onCancelTask) {
        result = this.onCancelTask(args.taskId)
      } else if (call.name === "request_screenshot" && this.onRequestScreenshot) {
        const dataUrl = await this.onRequestScreenshot()
        if (dataUrl) {
          const commaIdx = dataUrl.indexOf(",")
          const base64   = commaIdx !== -1 ? dataUrl.slice(commaIdx + 1) : dataUrl
          this.session?.sendClientContent({
            turns: [{
              role:  "user",
              parts: [
                { text: "[page screenshot]" },
                { inlineData: { mimeType: "image/jpeg", data: base64 } },
              ],
            }],
            turnComplete: false,
          })
        }
        result = { status: "captured" }
      } else {
        result = { status: "acknowledged", note: "Tool handler not yet wired" }
      }

      responses.push({ id: call.id ?? "", name: call.name ?? "", response: result })
      logger.info("Tool call handled", { sessionId: this.sessionId, tool: call.name, result })
    }

    this.session?.sendToolResponse({ functionResponses: responses })
  }
}
