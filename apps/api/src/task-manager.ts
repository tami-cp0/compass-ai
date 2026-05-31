import { v4 as uuidv4 } from "uuid"
import type { ExtensionMessage, SessionState, Task } from "@compass-ai/types"
import type { GeminiLiveSession } from "./gemini-live-session.js"
import { getConversationHistory } from "./redis.js"
import { runResearchAgent } from "./research-agent.js"
import { runWebAgent } from "./web-agent.js"
import { logger } from "./logger.js"

export class TaskManager {
  private session:          SessionState
  private gemini:           GeminiLiveSession
  private abortControllers:  Map<string, AbortController> = new Map()
  private pendingSnapshots = new Map<string, (msg: Extract<ExtensionMessage, { type: "dom_snapshot" }> | null) => void>()

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

  dispatchAutomation(name: string, description: string): Record<string, unknown> {
    if (this.session.automationSlot !== null) {
      return { status: "rejected", reason: "automation_slot_full" }
    }

    const taskId = uuidv4()
    const task: Task = {
      taskId,
      type:        "automation",
      name,
      description,
      status:      "running",
      startedAt:   Date.now(),
    }
    this.session.automationSlot = task

    const controller = new AbortController()
    this.abortControllers.set(taskId, controller)

    this._runAutomation(task)

    return { taskId, status: "dispatched" }
  }

  handleDomSnapshot(msg: Extract<ExtensionMessage, { type: "dom_snapshot" }>): void {
    const resolve = this.pendingSnapshots.get(msg.taskId)
    if (resolve) {
      this.pendingSnapshots.delete(msg.taskId)
      resolve(msg)
    }
  }

  private _runAutomation(task: Task): void {
    const { taskId, name, description } = task
    const sessionId = this.session.sessionId

    this.session.send({
      type:     "dom_snapshot_request",
      sessionId,
      taskId,
      taskType: "structure",
    })

    const snapshotPromise = new Promise<Extract<ExtensionMessage, { type: "dom_snapshot" }> | null>(
      (resolve) => {
        this.pendingSnapshots.set(taskId, resolve)

        setTimeout(() => {
          if (this.pendingSnapshots.has(taskId)) {
            this.pendingSnapshots.delete(taskId)
            resolve(null)
          }
        }, 30_000)
      }
    )

    snapshotPromise
      .then((snapshot) => {
        if (this.session.cancelledTasks.has(taskId)) {
          this.session.automationSlot = null
          this.abortControllers.delete(taskId)
          logger.info("Automation discarded — task was cancelled", { taskId })
          return
        }
        if (!snapshot) {
          this.session.automationSlot = null
          this.abortControllers.delete(taskId)
          this.gemini.injectContent(`[automation context] Task "${name}" failed: no DOM snapshot received within 30s`)
          logger.error("Automation timed out waiting for dom_snapshot", { taskId, name })
          return
        }
        return runWebAgent(description, snapshot.elementMap, snapshot.screenshot)
      })
      .then((result) => {
        if (!result) return
        if (this.session.cancelledTasks.has(taskId)) {
          logger.info("Automation result discarded — task was cancelled", { taskId })
          return
        }
        this.session.automationSlot = null
        this.abortControllers.delete(taskId)
        const planSummary = result.actions.map((a) => a.description).join(" → ")
        this.gemini.injectContent(
          `[automation context] Plan for "${name}": ${result.actions.length} step(s). ${planSummary}`
        )
        logger.info("Automation plan injected", { taskId, name, actionCount: result.actions.length })
      })
      .catch((err: unknown) => {
        this.pendingSnapshots.delete(taskId)
        if (this.session.cancelledTasks.has(taskId)) {
          logger.info("Automation error discarded — task was cancelled", { taskId })
          return
        }
        this.session.automationSlot = null
        this.abortControllers.delete(taskId)
        const message = err instanceof Error ? err.message : String(err)
        this.gemini.injectContent(`[automation context] Task "${name}" failed: ${message}`)
        logger.error("Automation task failed", { taskId, name, error: message })
      })
  }

  cancel(taskId: string): Record<string, unknown> {
    this.session.cancelledTasks.add(taskId)
    this.abortControllers.get(taskId)?.abort()
    this.abortControllers.delete(taskId)

    // Unblock any pending snapshot — _runAutomation will see cancelledTasks and clean up the slot
    const resolve = this.pendingSnapshots.get(taskId)
    if (resolve) {
      this.pendingSnapshots.delete(taskId)
      resolve(null)
    }

    const slotIndex = this.session.researchSlots.findIndex(s => s?.taskId === taskId)
    if (slotIndex !== -1) {
      (this.session.researchSlots as Array<Task | null>)[slotIndex] = null
    }

    logger.info("Task cancelled", { taskId })
    return { status: "cancelled" }
  }
}
