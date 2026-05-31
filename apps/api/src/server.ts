import { App, DISABLED } from "uWebSockets.js"
import { v4 as uuidv4 } from "uuid"
import type { ExtensionMessage, ServerMessage } from "@compass-ai/types"
import { createSession, deleteSession, sessionCount } from "./session-store.js"
import { logger } from "./logger.js"
import { GeminiLiveSession } from "./gemini-live-session.js"
import { getConversationHistory } from "./redis.js"
import { TaskManager } from "./task-manager.js"

const PORT = Number(process.env.PORT ?? 8787)

// Extended session handle — lives only in the API app, not in shared types
interface ApiSession {
  sessionId:    string
  gemini:       GeminiLiveSession
  taskManager:  TaskManager
}

const apiSessions = new Map<string, ApiSession>()

export function startServer(): void {
  const app = App()

  app.ws<{ sessionId: string }>("/ws", {
    compression:      DISABLED,
    maxPayloadLength: 16 * 1024 * 1024,
    idleTimeout:      120,

    async open(ws) {
      const sessionId = uuidv4()
      ws.getUserData().sessionId = sessionId

      const send = (msg: ServerMessage) => ws.send(JSON.stringify(msg))
      const session = createSession(sessionId, send)

      // Load prior history for system prompt
      const history = await getConversationHistory(sessionId)

      const gemini = new GeminiLiveSession(sessionId, send, history)
      const taskManager = new TaskManager(session, gemini)
      apiSessions.set(sessionId, { sessionId, gemini, taskManager })

      gemini.onDispatchResearch   = (name, desc) => taskManager.dispatchResearch(name, desc)
      gemini.onDispatchAutomation = (name, desc) => taskManager.dispatchAutomation(name, desc)
      gemini.onCancelTask         = (taskId)     => taskManager.cancel(taskId)

      await gemini.connect()

      ws.send(JSON.stringify({ type: "session_init", sessionId } satisfies ServerMessage))
      logger.info("Client connected", { sessionId, total: sessionCount() })
    },

    message(ws, rawMessage) {
      const { sessionId } = ws.getUserData()
      const apiSession = apiSessions.get(sessionId)
      if (!apiSession) return

      let msg: ExtensionMessage
      try {
        msg = JSON.parse(Buffer.from(rawMessage).toString("utf8")) as ExtensionMessage
      } catch {
        logger.warn("Unparseable message", { sessionId })
        return
      }

      if (msg.type === "audio_chunk") {
        apiSession.gemini.sendAudio(msg.data)
        return
      }

      if (msg.type === "dom_snapshot") {
        apiSession.taskManager.handleDomSnapshot(msg)
        return
      }

      logger.warn("Unhandled message type", { sessionId, type: msg.type })
    },

    async close(ws, code) {
      const { sessionId } = ws.getUserData()
      const apiSession = apiSessions.get(sessionId)
      if (apiSession) {
        await apiSession.gemini.close()
        apiSessions.delete(sessionId)
      }
      deleteSession(sessionId)
      logger.info("Client disconnected", { sessionId, code, total: sessionCount() })
    },
  })

  app.listen(PORT, (token) => {
    if (token) {
      logger.info("Server listening", { port: PORT })
    } else {
      logger.error("Failed to start server", { port: PORT })
      process.exit(1)
    }
  })
}
