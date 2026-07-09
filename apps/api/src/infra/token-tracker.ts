import { writeFileSync, mkdirSync, renameSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const IS_DEV = process.env.NODE_ENV === "development"
const _dir = dirname(fileURLToPath(import.meta.url))
// apps/api/src/infra → apps/api/logs
const OUTPUT_DIR = join(_dir, "..", "..", "logs")

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cachedTokens?: number
}

interface TaskTotals {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

interface AutomationStep {
  stepNumber: number
  usage: TokenUsage
}

interface AutomationTask {
  taskId: string
  name: string
  steps: AutomationStep[]
  totals: TaskTotals
}

interface ResearchTask {
  taskId: string
  name: string
  usage: TokenUsage
}

interface LiveUsage {
  totals: TaskTotals
  calls: number
  // Cumulative cached input tokens Gemini reported (cachedContentTokenCount).
  cachedInputTokens: number
  // Per-modality token split (TEXT / AUDIO / IMAGE / VIDEO), summed across turns.
  inputByModality: Record<string, number>
  outputByModality: Record<string, number>
}

// Minimal shape of Gemini's ModalityTokenCount[] — kept local so the tracker
// doesn't depend on the @google/genai types.
export interface ModalityTokens {
  input?: Array<{ modality?: string; tokenCount?: number }>
  output?: Array<{ modality?: string; tokenCount?: number }>
}

interface SessionReport {
  sessionId: string
  startedAt: string
  lastUpdatedAt: string
  totals: TaskTotals & { research: number; automation: number; live: number }
  research: ResearchTask[]
  automation: AutomationTask[]
  live: LiveUsage
}

function emptyReport(sessionId: string): SessionReport {
  const now = new Date().toISOString()
  return {
    sessionId,
    startedAt: now,
    lastUpdatedAt: now,
    totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, research: 0, automation: 0, live: 0 },
    research: [],
    automation: [],
    live: {
      totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      calls: 0,
      cachedInputTokens: 0,
      inputByModality: {},
      outputByModality: {},
    },
  }
}

export class TokenTracker {
  private report: SessionReport
  private enabled: boolean
  private outputPath: string

  constructor(sessionId: string) {
    this.enabled = IS_DEV
    this.report = emptyReport(sessionId)
    this.outputPath = join(OUTPUT_DIR, `tokens-${sessionId}.json`)
    if (this.enabled) {
      try {
        mkdirSync(OUTPUT_DIR, { recursive: true })
      } catch {
        /* dir already exists */
      }
      this.flush()
    }
  }

  recordResearch(taskId: string, name: string, usage: TokenUsage): void {
    if (!this.enabled) return
    this.report.research.push({ taskId, name, usage })
    this.recompute()
    this.flush()
  }

  recordAutomationStep(taskId: string, name: string, stepNumber: number, usage: TokenUsage): void {
    if (!this.enabled) return
    let task = this.report.automation.find((t) => t.taskId === taskId)
    if (!task) {
      task = { taskId, name, steps: [], totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }
      this.report.automation.push(task)
    }
    task.steps.push({ stepNumber, usage })
    task.totals.inputTokens += usage.inputTokens
    task.totals.outputTokens += usage.outputTokens
    task.totals.totalTokens += usage.totalTokens
    this.recompute()
    this.flush()
  }

  recordLive(usage: TokenUsage, modality?: ModalityTokens): void {
    if (!this.enabled) return
    this.report.live.calls++
    this.report.live.totals.inputTokens += usage.inputTokens
    this.report.live.totals.outputTokens += usage.outputTokens
    this.report.live.totals.totalTokens += usage.totalTokens
    this.report.live.cachedInputTokens += usage.cachedTokens ?? 0
    for (const d of modality?.input ?? []) {
      if (!d.modality) continue
      this.report.live.inputByModality[d.modality] =
        (this.report.live.inputByModality[d.modality] ?? 0) + (d.tokenCount ?? 0)
    }
    for (const d of modality?.output ?? []) {
      if (!d.modality) continue
      this.report.live.outputByModality[d.modality] =
        (this.report.live.outputByModality[d.modality] ?? 0) + (d.tokenCount ?? 0)
    }
    this.recompute()
    this.flush()
  }

  private recompute(): void {
    const researchTotal = this.report.research.reduce((s, r) => s + r.usage.totalTokens, 0)
    const automationTotal = this.report.automation.reduce((s, a) => s + a.totals.totalTokens, 0)
    const liveTotal = this.report.live.totals.totalTokens

    const inputTotal =
      this.report.research.reduce((s, r) => s + r.usage.inputTokens, 0) +
      this.report.automation.reduce((s, a) => s + a.totals.inputTokens, 0) +
      this.report.live.totals.inputTokens
    const outputTotal =
      this.report.research.reduce((s, r) => s + r.usage.outputTokens, 0) +
      this.report.automation.reduce((s, a) => s + a.totals.outputTokens, 0) +
      this.report.live.totals.outputTokens

    this.report.totals = {
      inputTokens: inputTotal,
      outputTokens: outputTotal,
      totalTokens: researchTotal + automationTotal + liveTotal,
      research: researchTotal,
      automation: automationTotal,
      live: liveTotal,
    }
    this.report.lastUpdatedAt = new Date().toISOString()
  }

  // Atomic write: tmp file + rename. Avoids partial reads if the file is being tailed.
  private flush(): void {
    const tmp = this.outputPath + ".tmp"
    writeFileSync(tmp, JSON.stringify(this.report, null, 2), "utf8")
    renameSync(tmp, this.outputPath)
  }
}
