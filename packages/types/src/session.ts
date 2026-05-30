import type { ServerMessage } from "./messages.js"

export type TaskType   = "research" | "automation"
export type TaskStatus = "running" | "completed" | "failed" | "cancelled"

export interface Task {
  taskId:          string
  type:            TaskType
  name:            string
  description:     string
  status:          TaskStatus
  startedAt:       number
}

export interface SessionState {
  sessionId:      string
  send:           (msg: ServerMessage) => void

  researchSlots:  [Task | null, Task | null]
  automationSlot: Task | null
  cancelledTasks: Set<string>
}
