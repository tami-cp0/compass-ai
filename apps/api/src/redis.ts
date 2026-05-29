import { Redis } from "ioredis"
import { logger } from "./logger.js"

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379"

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

const MAX_RECENT_TURNS = 6

export async function getConversationHistory(sessionId: string): Promise<ConversationHistory> {
  const raw = await redis.get(`conversation:${sessionId}`)
  if (!raw) return { summary: "", recentTurns: [] }
  return JSON.parse(raw) as ConversationHistory
}

export async function appendConversationTurn(
  sessionId: string,
  turn: { role: "user" | "assistant"; content: string },
  newSummary?: string
): Promise<void> {
  const history = await getConversationHistory(sessionId)
  history.recentTurns.push({ ...turn, timestamp: Date.now() })
  if (newSummary !== undefined) {
    history.summary = newSummary
    history.recentTurns = history.recentTurns.slice(-MAX_RECENT_TURNS)
  }
  await redis.set(`conversation:${sessionId}`, JSON.stringify(history))
}
