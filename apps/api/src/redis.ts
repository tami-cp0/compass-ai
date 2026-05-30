import { Redis } from "ioredis"
import { logger } from "./logger.js"
import * as dotenv from "dotenv"
dotenv.config()


if (!process.env.REDIS_URL) {
  throw new Error("REDIS_URL environment variable is not set")
}

const REDIS_URL = process.env.REDIS_URL

export const redis = new Redis(REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 3,
})

redis.on("connect", () => logger.info("Redis connected", { url: REDIS_URL }))
redis.on("error", (err: unknown) => logger.error("Redis error", { error: String(err) }))

export async function connectRedis(): Promise<void> {
  await redis.connect()
}

export interface Turn {
  role: "user" | "assistant"
  content: string
  timestamp: number
}

export interface ConversationHistory {
  summary: string
  recentTurns: Turn[]
}

export async function getConversationHistory(sessionId: string): Promise<ConversationHistory> {
  const raw = await redis.get(`conversation:${sessionId}`)
  if (!raw) return { summary: "", recentTurns: [] }
  return JSON.parse(raw) as ConversationHistory
}

export async function appendConversationTurn(
  sessionId: string,
  turn: { role: "user" | "assistant"; content: string }
): Promise<void> {
  const history = await getConversationHistory(sessionId)
  history.recentTurns.push({ ...turn, timestamp: Date.now() })

  while (history.recentTurns.length > 3) {
    const oldest = history.recentTurns.shift()!
    const index = history.summary ? history.summary.split("\n").length + 1 : 1
    const line = `${index}. ${oldest.role === "user" ? "User" : "Assistant"}: ${oldest.content}`
    history.summary = history.summary ? `${history.summary}\n${line}` : line
  }

  await redis.set(`conversation:${sessionId}`, JSON.stringify(history))
}
