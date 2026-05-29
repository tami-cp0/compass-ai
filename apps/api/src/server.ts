import { App, DISABLED } from "uWebSockets.js"
import { v4 as uuidv4 } from "uuid"
import type { ExtensionMessage, ServerMessage } from "@compass-ai/types"
import { createSession, deleteSession, sessionCount } from "./session-store.js"
import { logger } from "./logger.js"

const PORT = Number(process.env.PORT ?? 8787)

export function startServer(): void {
  const app = App()

  app.ws<{ sessionId: string }>("/ws", {
    compression: DISABLED,
    maxPayloadLength: 16 * 1024 * 1024,
    idleTimeout: 120,

    open(ws) {
      const sessionId = uuidv4()
      ws.getUserData().sessionId = sessionId
      createSession(sessionId, (msg: ServerMessage) => {
        ws.send(JSON.stringify(msg))
      })
      logger.info("Client connected", { sessionId, total: sessionCount() })
    },

    message(ws, rawMessage) {
      const { sessionId } = ws.getUserData()
      let msg: ExtensionMessage

      try {
        msg = JSON.parse(Buffer.from(rawMessage).toString("utf8")) as ExtensionMessage
      } catch {
        logger.warn("Unparseable message", { sessionId })
        return
      }

      logger.info("Message received", { sessionId, type: msg.type })
    },

    close(ws, code) {
      const { sessionId } = ws.getUserData()
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
