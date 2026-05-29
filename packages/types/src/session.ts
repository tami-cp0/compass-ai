import type { ServerMessage } from "./messages"

export interface QueuedTask {
  taskId: string
  type: "automation" | "research"
  description: string
  queuedReason: string
  queuedAt: number
}

export interface ActiveTask {
  type: "automation" | "research"
  description: string
}

export interface SessionState {
  sessionId: string
  send: (msg: ServerMessage) => void

  // Automation state
  automationState: "idle" | "running" | "paused" | "cancelled"
  currentTaskId: string | null
  currentAutomationDescription: string | null

  // Research state
  isResearching: boolean
  researchDescription: string | null

  // Task queue
  activeTasks: Map<string, ActiveTask>
  taskQueue: QueuedTask[]
}
