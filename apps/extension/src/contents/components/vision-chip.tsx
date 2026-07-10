import { Eye } from "lucide-react"

// Vision indicator — an exact clone of the research chip (same .research-chip
// styling and running-state animation), anchored to the LEFT of the pill. The
// only difference from a research chip is the icon (Eye vs Newspaper).
export const VisionChip = ({ on }: { on: boolean }) => {
  if (!on) return null
  return (
    <div className="absolute right-full top-1/2 -translate-y-1/2 mr-2 flex items-center">
      <div
        className="research-chip started"
        title="Compass can see your screen"
        aria-label="Vision on"
      >
        <Eye size={14} strokeWidth={2} />
      </div>
    </div>
  )
}
