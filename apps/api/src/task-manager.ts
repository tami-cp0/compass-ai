import { v4 as uuidv4 } from "uuid"
import type { SessionState, Task } from "@compass-ai/types"
import type { GeminiLiveSession } from "./gemini-live-session.js"
import { getConversationHistory } from "./redis.js"
import { runResearchAgent } from "./research-agent.js"
import { logger } from "./logger.js"

export class TaskManager {
  private session:          SessionState
  private gemini:           GeminiLiveSession
  private abortControllers: Map<string, AbortController> = new Map()

  constructor(session: SessionState, gemini: GeminiLiveSession) {
    this.session = session
    this.gemini  = gemini
  }

  dispatchResearch(name: string, description: string): Record<string, unknown> {
    const slotIndex = this.session.researchSlots.findIndex(s => s === null)
    if (slotIndex === -1) {
      return { status: "rejected", reason: "research_slots_full" }
    }

    const taskId = uuidv4()
    const task: Task = {
      taskId,
      type:        "research",
      name,
      description,
      status:      "running",
      startedAt:   Date.now(),
    }
    this.session.researchSlots[slotIndex] = task

    const controller = new AbortController()
    this.abortControllers.set(taskId, controller)

    this._runResearch(task, slotIndex, controller.signal)

    return { taskId, status: "dispatched" }
  }

  private _runResearch(task: Task, slotIndex: number, signal: AbortSignal): void {
    const { taskId, name, description } = task
    const sessionId = this.session.sessionId

    getConversationHistory(sessionId)
      .then((history) => {
        const context = history.recentTurns
          .slice(-3)
          .map(t => `${t.role === "user" ? "User" : "Compass"}: ${t.content}`)
          .join("\n")
        return runResearchAgent(description, context, signal)
      })
      .then((result) => {
        if (this.session.cancelledTasks.has(taskId)) {
          logger.info("Research result discarded — task was cancelled", { taskId })
          return
        }
        (this.session.researchSlots as Array<Task | null>)[slotIndex] = null
        this.abortControllers.delete(taskId)
        const payload = `[research_result: ${name}]\n${JSON.stringify(result)}`
        this.gemini.injectContent(payload)
        logger.info("Research result injected", { taskId, name, payload })
      })
      .catch((err: unknown) => {
        if (this.session.cancelledTasks.has(taskId)) {
          logger.info("Research error discarded — task was cancelled", { taskId })
          return
        }
        (this.session.researchSlots as Array<Task | null>)[slotIndex] = null
        this.abortControllers.delete(taskId)
        const message = err instanceof Error ? err.message : String(err)
        this.gemini.injectContent(`[research error] Task "${name}" failed: ${message}`)
        logger.error("Research task failed", { taskId, name, error: message })
      })
  }

  dispatchAutomation(_name: string, _description: string): Record<string, unknown> {
    return { status: "rejected", reason: "automation_not_implemented" }
  }

  cancel(taskId: string): Record<string, unknown> {
    this.session.cancelledTasks.add(taskId)
    this.abortControllers.get(taskId)?.abort()
    this.abortControllers.delete(taskId)

    const slotIndex = this.session.researchSlots.findIndex(s => s?.taskId === taskId)
    if (slotIndex !== -1) {
      (this.session.researchSlots as Array<Task | null>)[slotIndex] = null
    }

    logger.info("Task cancelled", { taskId })
    return { status: "cancelled" }
  }
}
