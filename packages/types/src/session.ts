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

  // Up to two research tasks in parallel, so a quick lookup isn't stuck behind
  // a running deep analysis (both go through the same grounded-prose agent).
  researchSlots:  [Task | null, Task | null]
  automationSlot: Task | null
  cancelledTasks: Set<string>
}
