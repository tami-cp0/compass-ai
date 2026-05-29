import cssText from "data-text:~/styles/globals.css"
import { MicIcon, MicOff } from "lucide-react"
import type { PlasmoCSUI } from "plasmo"

export const getStyle = () => {
  const style = document.createElement("style")
  style.textContent = cssText
  return style
}

const Pill = () => {
  return (
    <div className="fixed top-6 flex justify-center w-full pointer-events-none z-[99999]">
      <div
        className="relative w-fit h-fit bg-white/60 backdrop-blur-xl border border-white/30 rounded-2xl shadow-2xl pointer-events-auto cursor-default
            before:absolute before:inset-0 before:rounded-2xl
            before:bg-gradient-to-br before:from-white/20 before:to-transparent
            after:absolute after:inset-0 after:rounded-2xl
            after:bg-gradient-to-tl after:from-black/10 after:to-transparent">
        <div className="flex gap-2 justify-center items-center rounded-full">
          <span className="inline-flex items-center justify-center relative z-10 h-8 px-2 leading-none">compass</span>
          <div className=" border-5 p-1 border rounded-full">
            <MicIcon size={16} className=" text-green-500" />
          </div>
        </div>
      </div>
    </div>
  )
}

export default Pill
