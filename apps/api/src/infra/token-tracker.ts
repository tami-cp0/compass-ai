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
  // Cached input tokens (prompt-cache reads) across steps — the web-agent
  // caches its system+tools prefix, so this shows how much the cache saved.
  cachedInputTokens: number
}

export type ResearchKind = "deep" | "quick"

interface ResearchTask {
  taskId: string
  name: string
  kind: ResearchKind
  usage: TokenUsage
}

// Per-kind research rollup so the report shows deep-research vs quick_search
// separately — they have very different cost profiles.
interface ResearchKindTotals {
  count: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
}

// Vision (continuous screen streaming) accounting. Frame tokens are billed by
// Gemini inside the live turn and land in live.inputByModality.VIDEO; here we
// track how the agent *used* vision — how often it turned it on, and per mode.
interface VisionUsage {
  enableCount: number
  byMode: Record<string, number> // "glance" | "sustained" -> times enabled
  // Frames pushed to the model across the session. Per-frame cost depends on
  // mediaResolution (currently HIGH = 280 tokens/frame; LOW/MEDIUM/default =
  // 70); the exact billed total is live.video.
  framesSent: number
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
  // Quick, glanceable rollups at the top of the file.
  summary: {
    researchDeep: ResearchKindTotals
    researchQuick: ResearchKindTotals
    automation: { runs: number; steps: number; totalTokens: number; cachedInputTokens: number }
    live: { calls: number; totalTokens: number; cachedInputTokens: number; frameTokens: number }
    vision: VisionUsage
  }
  research: ResearchTask[]
  automation: AutomationTask[]
  live: LiveUsage
  vision: VisionUsage
}

function emptyKindTotals(): ResearchKindTotals {
  return { count: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0 }
}

function emptyReport(sessionId: string): SessionReport {
  const now = new Date().toISOString()
  return {
    sessionId,
    startedAt: now,
    lastUpdatedAt: now,
    totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, research: 0, automation: 0, live: 0 },
    summary: {
      researchDeep: emptyKindTotals(),
      researchQuick: emptyKindTotals(),
      automation: { runs: 0, steps: 0, totalTokens: 0, cachedInputTokens: 0 },
      live: { calls: 0, totalTokens: 0, cachedInputTokens: 0, frameTokens: 0 },
      vision: { enableCount: 0, byMode: {}, framesSent: 0 },
    },
    research: [],
    automation: [],
    live: {
      totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      calls: 0,
      cachedInputTokens: 0,
      inputByModality: {},
      outputByModality: {},
    },
    vision: { enableCount: 0, byMode: {}, framesSent: 0 },
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

  recordResearch(taskId: string, name: string, usage: TokenUsage, kind: ResearchKind): void {
    if (!this.enabled) return
    this.report.research.push({ taskId, name, kind, usage })
    this.recompute()
    this.flush()
  }

  // The live agent turned its vision on. Frame tokens are billed inside the
  // live turn (see recordLive VIDEO modality); this just counts intent.
  recordVisionEnabled(mode: string): void {
    if (!this.enabled) return
    this.report.vision.enableCount++
    this.report.vision.byMode[mode] = (this.report.vision.byMode[mode] ?? 0) + 1
    this.recompute()
    this.flush()
  }

  // A vision-stream frame was pushed to the model. Cheap counter (no flush) —
  // frames arrive ~1/sec and the exact billed cost lands in live VIDEO tokens.
  recordVisionFrame(): void {
    if (!this.enabled) return
    this.report.vision.framesSent++
  }

  recordAutomationStep(taskId: string, name: string, stepNumber: number, usage: TokenUsage): void {
    if (!this.enabled) return
    let task = this.report.automation.find((t) => t.taskId === taskId)
    if (!task) {
      task = { taskId, name, steps: [], totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, cachedInputTokens: 0 }
      this.report.automation.push(task)
    }
    task.steps.push({ stepNumber, usage })
    task.totals.inputTokens += usage.inputTokens
    task.totals.outputTokens += usage.outputTokens
    task.totals.totalTokens += usage.totalTokens
    task.cachedInputTokens += usage.cachedTokens ?? 0
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

    // Glanceable summary rollups.
    const kindTotals = (kind: ResearchKind): ResearchKindTotals => {
      const rows = this.report.research.filter((r) => r.kind === kind)
      return {
        count: rows.length,
        totalTokens: rows.reduce((s, r) => s + r.usage.totalTokens, 0),
        inputTokens: rows.reduce((s, r) => s + r.usage.inputTokens, 0),
        outputTokens: rows.reduce((s, r) => s + r.usage.outputTokens, 0),
      }
    }
    this.report.summary = {
      researchDeep: kindTotals("deep"),
      researchQuick: kindTotals("quick"),
      automation: {
        runs: this.report.automation.length,
        steps: this.report.automation.reduce((s, a) => s + a.steps.length, 0),
        totalTokens: automationTotal,
        cachedInputTokens: this.report.automation.reduce((s, a) => s + a.cachedInputTokens, 0),
      },
      live: {
        calls: this.report.live.calls,
        totalTokens: liveTotal,
        cachedInputTokens: this.report.live.cachedInputTokens,
        // Vision frames bill as IMAGE (not VIDEO) for the Live model, and
        // re-bill each turn while in the context window — so this is cumulative
        // across turns, not framesSent × per-frame rate.
        frameTokens:
          (this.report.live.inputByModality["IMAGE"] ?? 0) +
          (this.report.live.inputByModality["VIDEO"] ?? 0),
      },
      vision: this.report.vision,
    }
    this.report.lastUpdatedAt = new Date().toISOString()
  }

  // Flat rollup for the session-summary log line. Zeros in prod (detailed
  // per-task tracking only runs in dev), but the shape is always present.
  summary(): SessionReport["summary"] {
    return this.report.summary
  }

  // Atomic write: tmp file + rename. Avoids partial reads if the file is being tailed.
  private flush(): void {
    const tmp = this.outputPath + ".tmp"
    writeFileSync(tmp, JSON.stringify(this.report, null, 2), "utf8")
    renameSync(tmp, this.outputPath)
  }
}
