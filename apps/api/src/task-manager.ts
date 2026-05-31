import { v4 as uuidv4 } from "uuid"
import type { ExtensionMessage, SessionState, Task, WebIntent } from "@compass-ai/types"
import type { WebAction } from "../baml_client/types.js"
import type { GeminiLiveSession } from "./gemini-live-session.js"
import { getConversationHistory } from "./redis.js"
import { runResearchAgent } from "./research-agent.js"
import { runWebAgent } from "./web-agent.js"
import { logger } from "./logger.js"

export class TaskManager {
  private session:                   SessionState
  private gemini:                    GeminiLiveSession
  private abortControllers:          Map<string, AbortController> = new Map()
  private pendingSnapshots         = new Map<string, (msg: Extract<ExtensionMessage, { type: "dom_snapshot" }> | null) => void>()
  private pendingActionResults     = new Map<string, (msg: Extract<ExtensionMessage, { type: "action_result" }> | null) => void>()
  private pendingUserActionResults = new Map<string, (msg: Extract<ExtensionMessage, { type: "user_action_result" }> | null) => void>()

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

  handleActionResult(msg: Extract<ExtensionMessage, { type: "action_result" }>): void {
    const resolve = this.pendingActionResults.get(msg.actionId)
    if (resolve) {
      this.pendingActionResults.delete(msg.actionId)
      resolve(msg)
    }
  }

  handleUserActionResult(msg: Extract<ExtensionMessage, { type: "user_action_result" }>): void {
    const resolve = this.pendingUserActionResults.get(msg.actionId)
    if (resolve) {
      this.pendingUserActionResults.delete(msg.actionId)
      resolve(msg)
    }
  }

  private _sendAutomationEnd(taskId: string, reason: "complete" | "cancelled" | "error", error?: string): void {
    this.session.send({
      type:      "automation_end",
      sessionId: this.session.sessionId,
      taskId,
      reason,
      ...(error ? { error } : {}),
    })
  }

  private _buildIntent(action: WebAction): WebIntent | null {
    if (action.action === "click" && action.element_id != null) {
      return { action: "click", element_id: action.element_id }
    }
    if (action.action === "type" && action.element_id != null && action.value != null) {
      return { action: "type", element_id: action.element_id, value: action.value }
    }
    if (action.action === "scroll" && action.direction != null && action.amount != null) {
      return {
        action:     "scroll",
        element_id: action.element_id ?? null,
        direction:  action.direction as "up" | "down",
        amount:     action.amount,
      }
    }
    if (action.action === "highlight" && action.element_id != null && action.text_snippet != null) {
      return { action: "highlight", element_id: action.element_id, text_snippet: action.text_snippet }
    }
    return null
  }

  private async _executeAction(
    taskId: string,
    action: WebAction,
  ): Promise<{ success: boolean; error?: string }> {
    const actionId   = uuidv4()
    const sessionId  = this.session.sessionId

    const intent = this._buildIntent(action)
    if (!intent) {
      return { success: false, error: `Cannot build intent for action "${action.action}" — missing required fields` }
    }

    if (action.isCritical) {
      this.session.send({
        type:        "user_action_required",
        sessionId,
        actionId,
        taskId,
        description: action.description,
      })

      const userResult = await new Promise<Extract<ExtensionMessage, { type: "user_action_result" }> | null>(
        (resolve) => {
          this.pendingUserActionResults.set(actionId, resolve)
          setTimeout(() => {
            if (this.pendingUserActionResults.has(actionId)) {
              this.pendingUserActionResults.delete(actionId)
              resolve(null)
            }
          }, 120_000)
        }
      )

      if (!userResult) {
        return { success: false, error: "User confirmation timed out" }
      }
      if (!userResult.confirmed) {
        return { success: false, error: "User declined the action" }
      }
    }

    this.session.send({
      type:       "action",
      sessionId,
      actionId,
      taskId,
      intent,
      isCritical: action.isCritical,
    })

    const result = await new Promise<Extract<ExtensionMessage, { type: "action_result" }> | null>(
      (resolve) => {
        this.pendingActionResults.set(actionId, resolve)
        setTimeout(() => {
          if (this.pendingActionResults.has(actionId)) {
            this.pendingActionResults.delete(actionId)
            resolve(null)
          }
        }, 15_000)
      }
    )

    if (!result) {
      return { success: false, error: "Action timed out after 15s" }
    }
    return { success: result.success, error: result.error }
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
      .then(async (snapshot) => {
        if (this.session.cancelledTasks.has(taskId)) {
          this.session.automationSlot = null
          this.abortControllers.delete(taskId)
          this._sendAutomationEnd(taskId, "cancelled")
          logger.info("Automation discarded — task was cancelled", { taskId })
          return
        }
        if (!snapshot) {
          this.session.automationSlot = null
          this.abortControllers.delete(taskId)
          this._sendAutomationEnd(taskId, "error", "No DOM snapshot received within 30s")
          this.gemini.injectContent(`[automation context] Task "${name}" failed: no DOM snapshot received within 30s`)
          logger.error("Automation timed out waiting for dom_snapshot", { taskId, name })
          return
        }

        const webAgentResult = await runWebAgent(description, snapshot.elementMap, snapshot.screenshot)

        if (this.session.cancelledTasks.has(taskId)) {
          this.session.automationSlot = null
          this.abortControllers.delete(taskId)
          this._sendAutomationEnd(taskId, "cancelled")
          logger.info("Automation result discarded — task was cancelled after planning", { taskId })
          return
        }

        const actions = webAgentResult.actions
        logger.info("Automation executing plan", { taskId, name, actionCount: actions.length })

        for (let i = 0; i < actions.length; i++) {
          if (this.session.cancelledTasks.has(taskId)) {
            this.session.automationSlot = null
            this.abortControllers.delete(taskId)
            this._sendAutomationEnd(taskId, "cancelled")
            logger.info("Automation cancelled mid-execution", { taskId, step: i })
            return
          }

          const action = actions[i]
          const result = await this._executeAction(taskId, action)
          logger.info("Action executed", { taskId, step: i + 1, action: action.action, success: result.success, error: result.error })

          if (!result.success) {
            this.session.automationSlot = null
            this.abortControllers.delete(taskId)
            const errorMsg = result.error ?? "Unknown error"
            this._sendAutomationEnd(taskId, "error", errorMsg)
            this.gemini.injectContent(
              `[automation context] Task "${name}" failed at step ${i + 1} (${action.description}): ${errorMsg}`
            )
            logger.error("Automation step failed", { taskId, name, step: i + 1, error: errorMsg })
            return
          }
        }

        this.session.automationSlot = null
        this.abortControllers.delete(taskId)
        this._sendAutomationEnd(taskId, "complete")
        const planSummary = actions.map((a) => a.description).join(" → ")
        this.gemini.injectContent(
          `[automation context] Task "${name}" completed: ${actions.length} step(s) executed. ${planSummary}`
        )
        logger.info("Automation completed", { taskId, name, actionCount: actions.length })
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
        this._sendAutomationEnd(taskId, "error", message)
        this.gemini.injectContent(`[automation context] Task "${name}" failed: ${message}`)
        logger.error("Automation task failed", { taskId, name, error: message })
      })
  }

  cancel(taskId: string): Record<string, unknown> {
    this.session.cancelledTasks.add(taskId)
    this.abortControllers.get(taskId)?.abort()
    this.abortControllers.delete(taskId)

    // Unblock any pending snapshot — _runAutomation will see cancelledTasks and clean up the slot
    const snapshotResolve = this.pendingSnapshots.get(taskId)
    if (snapshotResolve) {
      this.pendingSnapshots.delete(taskId)
      snapshotResolve(null)
    }

    // Unblock all pending action results (keyed by actionId, not taskId — clear all)
    for (const [actionId, resolve] of this.pendingActionResults) {
      resolve(null)
      this.pendingActionResults.delete(actionId)
    }

    // Unblock all pending user-action results
    for (const [actionId, resolve] of this.pendingUserActionResults) {
      resolve(null)
      this.pendingUserActionResults.delete(actionId)
    }

    const slotIndex = this.session.researchSlots.findIndex(s => s?.taskId === taskId)
    if (slotIndex !== -1) {
      (this.session.researchSlots as Array<Task | null>)[slotIndex] = null
    }

    logger.info("Task cancelled", { taskId })
    return { status: "cancelled" }
  }
}
