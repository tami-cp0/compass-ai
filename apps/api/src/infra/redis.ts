import { Redis } from "ioredis"
import { logger } from "./logger.js"
import * as dotenv from "dotenv"
dotenv.config()

if (!process.env.REDIS_URL) {
  throw new Error("REDIS_URL environment variable is not set")
}

export const redis = new Redis(process.env.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 3,
})

redis.on("connect", () => logger.info("Redis connected"))
redis.on("error", (err: unknown) => logger.error("Redis error", { error: String(err) }))

export async function connectRedis(): Promise<void> {
  await redis.connect()
}

export interface Turn {
  role:      "user" | "model"
  content:   string
  timestamp: number
}

export interface ConversationHistory {
  summary:     string
  recentTurns: Turn[]
}

export async function getConversationHistory(sessionId: string): Promise<ConversationHistory> {
  const raw = await redis.get(`conversation:${sessionId}`)
  if (!raw) return { summary: "", recentTurns: [] }
  return JSON.parse(raw) as ConversationHistory
}

export async function saveConversationHistory(sessionId: string, history: ConversationHistory): Promise<void> {
  await redis.set(`conversation:${sessionId}`, JSON.stringify(history))
}

export async function appendTurn(
  sessionId: string,
  turn: { role: "user" | "model"; content: string }
): Promise<void> {
  const history = await getConversationHistory(sessionId)
  history.recentTurns.push({ ...turn, timestamp: Date.now() })

  while (history.recentTurns.length > 6) {
    const oldest = history.recentTurns.shift()!
    const index  = history.summary ? history.summary.split("\n").length + 1 : 1
    const prefix = oldest.role === "user" ? "User" : "Compass"
    history.summary = history.summary
      ? `${history.summary}\n${index}. ${prefix}: ${oldest.content}`
      : `${index}. ${prefix}: ${oldest.content}`
  }

  await redis.set(`conversation:${sessionId}`, JSON.stringify(history))
}
