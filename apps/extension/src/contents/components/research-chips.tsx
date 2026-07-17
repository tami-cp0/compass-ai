import { Newspaper } from "lucide-react"

import type { ResearchTask } from "../hooks/use-session"

// One small circle per running background research task, anchored to the
// right of the pill. Running: green-glass chip with a pulsing newspaper icon
// (opacity only, no size change). Completed/failed: solid green/red flash,
// then the hook drops the task and the chip disappears. Hover shows the task
// name via the native tooltip.
export const ResearchChips = ({ tasks }: { tasks: ResearchTask[] }) => {
  if (tasks.length === 0) return null
  return (
    <div className="absolute left-full top-1/2 -translate-y-1/2 ml-2 flex items-center gap-2">
      {tasks.map((t) => (
        <div
          key={t.taskId}
          className={`research-chip ${t.status}`}
          title={t.name}
          aria-label={`Research: ${t.name} (${t.status})`}
        >
          <Newspaper size={14} strokeWidth={2} />
        </div>
      ))}
    </div>
  )
}
