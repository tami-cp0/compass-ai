import type { SessionState, ServerMessage } from "@compass-ai/types"

// temporarily in memory
const sessions = new Map<string, SessionState>()

export function createSession(sessionId: string, send: (msg: ServerMessage) => void): SessionState {
  const session: SessionState = {
    sessionId,
    send,
    automationState: "idle",
    currentTaskId: null,
    currentAutomationDescription: null,
    isResearching: false,
    researchDescription: null,
    activeTasks: new Map(),
    taskQueue: [],
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
