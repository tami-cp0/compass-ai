import type { SessionState, ServerMessage } from "@compass-ai/types"

const sessions = new Map<string, SessionState>()

export function createSession(sessionId: string, send: (msg: ServerMessage) => void): SessionState {
  const session: SessionState = {
    sessionId,
    send,
    researchSlots:  [null],
    automationSlot: null,
    cancelledTasks: new Set(),
  }
  sessions.set(sessionId, session)
  return session
}

export function getSession(sessionId: string): SessionState | undefined {
  return sessions.get(sessionId)
}

export function deleteSession(sessionId: string): void {
  sessions.delete(sessionId)
}

export function sessionCount(): number {
  return sessions.size
}
