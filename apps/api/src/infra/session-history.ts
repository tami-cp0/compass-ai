// In-memory per-session store for conversation history + Gemini resumption
// handles. Previously Redis-backed; moved in-process because this state lives
// and dies with the WebSocket anyway and the app is single-instance. A server
// restart drops it — sessions reconnect fresh, same as any socket drop.
//
// The functions stay async so callers (gemini-live-session, server) are
// unchanged from the Redis surface they replaced.

export interface Turn {
  role:      "user" | "model"
  content:   string
  timestamp: number
}

export interface ConversationHistory {
  summary:     string
  recentTurns: Turn[]
}

// Gemini Live caps handle validity around 10 minutes.
const HANDLE_TTL_MS = 600_000

const conversations = new Map<string, ConversationHistory>()
const handles = new Map<string, { handle: string; expiresAt: number }>()

export async function getConversationHistory(sessionId: string): Promise<ConversationHistory> {
  const existing = conversations.get(sessionId)
  if (!existing) return { summary: "", recentTurns: [] }
  // Return a copy so callers can't mutate the stored object in place.
  return { summary: existing.summary, recentTurns: [...existing.recentTurns] }
}

export async function saveConversationHistory(sessionId: string, history: ConversationHistory): Promise<void> {
  conversations.set(sessionId, history)
}

export async function setResumptionHandle(sessionId: string, handle: string): Promise<void> {
  handles.set(sessionId, { handle, expiresAt: Date.now() + HANDLE_TTL_MS })
}

export async function getResumptionHandle(sessionId: string): Promise<string | null> {
  const entry = handles.get(sessionId)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    handles.delete(sessionId)
    return null
  }
  return entry.handle
}

export async function deleteResumptionHandle(sessionId: string): Promise<void> {
  handles.delete(sessionId)
}

// Drop all in-memory state for a session (history + handle). Called on
// session_end / teardown so ended sessions don't linger in the maps.
export function clearSessionHistory(sessionId: string): void {
  conversations.delete(sessionId)
  handles.delete(sessionId)
}

export async function appendTurn(
  sessionId: string,
  turn: { role: "user" | "model"; content: string }
): Promise<void> {
  const history = conversations.get(sessionId) ?? { summary: "", recentTurns: [] }
  history.recentTurns.push({ ...turn, timestamp: Date.now() })

  while (history.recentTurns.length > 6) {
    const oldest = history.recentTurns.shift()!
    const index  = history.summary ? history.summary.split("\n").length + 1 : 1
    const prefix = oldest.role === "user" ? "User" : "Compass"
    history.summary = history.summary
      ? `${history.summary}\n${index}. ${prefix}: ${oldest.content}`
      : `${index}. ${prefix}: ${oldest.content}`
  }

  conversations.set(sessionId, history)
}
