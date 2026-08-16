import { KeyRound, Mic, MicOff, Pencil, RotateCw, TriangleAlert, Wallet, X } from "lucide-react"

import type { StashedSessionError } from "../hooks/use-session-error"

// Verified provider billing consoles (branch by provider).
const BILLING_URL = {
  gemini: "https://aistudio.google.com/apikey",
  claude: "https://console.anthropic.com/settings/billing"
} as const

const PROVIDER_LABEL = { gemini: "Gemini", claude: "Claude" } as const

interface ModalContent {
  icon: "wallet" | "key" | "mic-off" | "mic" | "alert"
  title: string
  body: string
  action:
    | { kind: "link"; label: string; href: string }
    | { kind: "fixkey"; label: string }
    | { kind: "retry"; label: string }
    | { kind: "dismiss"; label: string }
  note?: string
}

// Generic fallback for errors that aren't individually actionable (transient /
// unexpected server failures). Just explains the session ended and lets the
// user close it.
function genericError(): ModalContent {
  return {
    icon: "alert",
    title: "Session ended",
    body: "Something went wrong and Compass had to end the session. Start it again from the pill to keep going.",
    action: { kind: "dismiss", label: "Dismiss" }
  }
}

// Maps the stashed error → what the popup shows. `missing_key` is treated like
// invalid_key (both are fixed by editing the key below).
function contentFor(err: StashedSessionError): ModalContent | null {
  // Microphone problems are client-side (no provider).
  if (err.kind === "mic_denied") {
    return {
      icon: "mic-off",
      title: "Microphone is blocked",
      body:
        "Compass listens through your microphone, but the browser is blocking access. Click the microphone icon in the address bar to allow it, then try again.",
      action: { kind: "retry", label: "Try again" },
      note: "Audio is streamed only while a session is active. Nothing is recorded."
    }
  }
  if (err.kind === "mic_missing") {
    return {
      icon: "mic",
      title: "No microphone found",
      body:
        "Compass couldn't find a microphone. Plug one in or check your system sound settings, then try again.",
      action: { kind: "retry", label: "Try again" },
      note: "Audio is streamed only while a session is active. Nothing is recorded."
    }
  }

  // Non-actionable / unexpected errors, or a provider-scoped error with no
  // provider — show the generic "session ended" popup rather than nothing.
  const provider = err.provider
  if (err.kind === "other" || !provider) return genericError()
  const name = PROVIDER_LABEL[provider]

  if (err.kind === "credits") {
    return {
      icon: "wallet",
      title: `${name} credits used up`,
      body: `Your ${name} API key is out of credits, so Compass can't make calls with it right now. Top up to continue.`,
      action: { kind: "link", label: `Add ${name} credits`, href: BILLING_URL[provider] },
      note: "Your key stays in this browser. We can't see your balance — this is just what the API returned."
    }
  }
  // invalid_key + missing_key
  return {
    icon: "key",
    title: err.kind === "missing_key" ? `${name} key needed` : `${name} key isn't valid`,
    body:
      err.kind === "missing_key"
        ? `Compass needs your ${name} API key to start. Add it below.`
        : `${name} rejected this API key. Double-check you pasted it correctly, or replace it below.`,
    action: { kind: "fixkey", label: err.kind === "missing_key" ? `Add ${name} key` : `Update ${name} key` },
    note: "Your key stays in this browser and is only sent to make your own API calls."
  }
}

function ModalIcon({ icon }: { icon: ModalContent["icon"] }) {
  const cls = "size-[1.4rem] text-white/85"
  if (icon === "wallet") return <Wallet className={cls} strokeWidth={2} />
  if (icon === "key") return <KeyRound className={cls} strokeWidth={2} />
  if (icon === "mic-off") return <MicOff className={cls} strokeWidth={2} />
  if (icon === "alert") return <TriangleAlert className={cls} strokeWidth={2} />
  return <Mic className={cls} strokeWidth={2} />
}

// Blocking modal shown when a provider rejects the session (out of credits /
// invalid key / missing key). Dismissible (scrim, ×, Esc handled by parent).
export function ErrorModal({
  error,
  onDismiss,
  onFixKey,
  onRetryMic
}: {
  error: StashedSessionError | null
  onDismiss: () => void
  onFixKey: (provider: "gemini" | "claude") => void
  onRetryMic: () => void
}) {
  const open = error !== null
  const content = error ? contentFor(error) : null

  return (
    <div
      className={`error-modal fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/60 backdrop-blur-sm ${open ? "open" : "hidden"}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onDismiss()
      }}>
      {content && error && (
        <div className="error-modal-card glass-neutral relative w-full max-w-[20rem] rounded-[1.1rem] px-5 pt-6 pb-5 text-center">
          <button
            type="button"
            aria-label="Dismiss"
            onClick={onDismiss}
            className="absolute right-3 top-3 grid size-6 place-items-center rounded-full text-white/40 hover:bg-white/10 hover:text-white/85 transition">
            <X className="size-4" />
          </button>

          <div className="mx-auto mb-3.5 grid size-[2.9rem] place-items-center rounded-full bg-white/[0.06] shadow-[inset_0_1px_0_hsla(0,0%,100%,0.14),inset_0_0_0_1px_hsla(0,0%,100%,0.08)]">
            <ModalIcon icon={content.icon} />
          </div>

          <div className="mb-1.5 text-[15px] font-semibold text-white/95">{content.title}</div>
          <div className="mb-[1.15rem] text-[12px] leading-relaxed text-white/60">{content.body}</div>

          {content.action.kind === "link" && (
            <a
              href={content.action.href}
              target="_blank"
              rel="noreferrer"
              className="error-modal-action glass-emerald flex h-[2.6rem] w-full items-center justify-center gap-1.5 rounded-xl text-[13px] font-semibold text-white/95">
              {content.action.label}
            </a>
          )}
          {content.action.kind === "fixkey" && (
            <button
              type="button"
              onClick={() => error.provider && onFixKey(error.provider)}
              className="error-modal-action glass-emerald flex h-[2.6rem] w-full items-center justify-center gap-1.5 rounded-xl text-[13px] font-semibold text-white/95">
              <Pencil className="size-[0.95rem]" strokeWidth={2} />
              {content.action.label}
            </button>
          )}
          {content.action.kind === "retry" && (
            <button
              type="button"
              onClick={onRetryMic}
              className="error-modal-action glass-emerald flex h-[2.6rem] w-full items-center justify-center gap-1.5 rounded-xl text-[13px] font-semibold text-white/95">
              <RotateCw className="size-[0.95rem]" strokeWidth={2} />
              {content.action.label}
            </button>
          )}
          {content.action.kind === "dismiss" && (
            <button
              type="button"
              onClick={onDismiss}
              className="flex h-[2.6rem] w-full items-center justify-center gap-1.5 rounded-xl border border-white/15 bg-white/[0.06] text-[13px] font-semibold text-white/90 transition hover:bg-white/[0.1]">
              {content.action.label}
            </button>
          )}

          {content.note && (
            <p className="mt-3.5 text-[10.5px] leading-snug text-white/30">{content.note}</p>
          )}
        </div>
      )}
    </div>
  )
}
