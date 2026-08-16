import { ArrowRight, Check, ChevronDown, Mail, Trash2 } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { CompassIcon } from "~contents/components/compass-icon"
import { ErrorModal } from "~contents/components/error-modal"
import { useSessionError } from "~contents/hooks/use-session-error"
import {
  getCredentials,
  isSignedUp,
  isValidEmail,
  setCredentials,
  type Credentials,
  type VoiceGender
} from "~contents/lib/credentials"
import "~styles/globals.css"

const GEMINI_KEYS_URL = "https://aistudio.google.com/apikey"
const CLAUDE_KEYS_URL = "https://console.anthropic.com/settings/keys"
const REPO_URL = "https://github.com/tami-cp0/compass-ai"

function maskKey(key: string): string {
  return `••••••${key.trim().slice(-4)}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Onboarding: the "Get started" pill that morphs into an email pane, then a
// light-sweep closes it. Class-driven stage machine mirroring the pin-panel's
// discipline (width grows first, then height; fixed radius so no stage is a
// circle). Stages: idle → s1 → s2 → pane → reveal → open → closing →
// collapsing → closed.
// ─────────────────────────────────────────────────────────────────────────────

type MorphStage =
  | "idle"
  | "s1"
  | "s2"
  | "pane"
  | "reveal"
  | "open"
  | "closing"
  | "collapsing"
  | "closed"

function Onboarding({ onDone }: { onDone: (email: string) => void }) {
  const [stage, setStage] = useState<MorphStage>("idle")
  const [email, setEmail] = useState("")
  const [touched, setTouched] = useState(false)
  const valid = isValidEmail(email)
  const inputRef = useRef<HTMLInputElement>(null)

  // Focus the email field once the pane is open.
  useEffect(() => {
    if (stage === "open") inputRef.current?.focus()
  }, [stage])

  // The preview's stage machine is ADDITIVE — each stage's class stays on the
  // wrap (so at "open" it carries s1 s2 pane reveal open) and the CSS rules are
  // cumulative. Replicate that exactly: derive the class list from the stage
  // rather than swapping a single class (swapping retriggers/drops transitions
  // and causes the glitch). The closing path removes open/reveal, matching the
  // preview's closePane().
  const ORDER: MorphStage[] = ["s1", "s2", "pane", "reveal", "open"]
  const wrapClasses = (() => {
    if (stage === "idle") return "idle"
    if (stage === "closing") return "s1 s2 pane closing"
    if (stage === "collapsing") return "s1 s2 pane closing collapsing"
    if (stage === "closed") return "s1 s2 pane closed"
    // forward stages: accumulate up to and including the current one
    return ORDER.slice(0, ORDER.indexOf(stage) + 1).join(" ")
  })()

  const openPane = () => {
    if (stage !== "idle") return
    setStage("s1") // disc morphs to pill height
  }

  const closePane = () => {
    if (stage !== "open") return
    if (!valid) {
      setTouched(true)
      inputRef.current?.focus()
      return
    }
    setStage("closing")
  }

  // The emerald layer finishes each morph → advance width/height stages.
  const onEmeraldTransitionEnd = (e: React.TransitionEvent) => {
    if (stage === "s1" && e.propertyName === "height") setStage("s2")
    else if (stage === "s2" && e.propertyName === "width") setStage("pane")
  }

  // The wrap finishes a height transition → sweep the light, or (after collapse)
  // hand off to the settings view.
  const onWrapTransitionEnd = (e: React.TransitionEvent) => {
    if (e.currentTarget !== e.target || e.propertyName !== "height") return
    if (stage === "pane") setStage("reveal")
    else if (stage === "collapsing") {
      setStage("closed")
      onDone(email.trim())
    }
  }

  // The light sweep ends → reveal content (open) or begin the collapse.
  const onLightAnimationEnd = () => {
    if (stage === "reveal") setStage("open")
    else if (stage === "closing") setStage("collapsing")
  }

  return (
    <div className="flex items-start justify-center pt-10 font-orbitron">
      <div
        className={`gs-wrap glass-neutral ${wrapClasses}`}
        onClick={openPane}
        onTransitionEnd={onWrapTransitionEnd}>
        {/* emerald layer: disc → pill → pane fill */}
        <div className="gs-emerald glass-emerald" onTransitionEnd={onEmeraldTransitionEnd} />

          {/* compass icon, pinned left */}
          <div className="gs-icon">
            <CompassIcon className="size-7 spin-slow" />
          </div>

          <span className="gs-label text-sm font-semibold tracking-wide text-white/90">
            Get started
          </span>

          {/* pane content: email + continue */}
          <div className="gs-content">
            <div className="flex flex-col gap-1">
              <p className="text-[13px] font-semibold text-white leading-tight">Enter your email</p>
              <p className="text-[11px] text-white/55 leading-snug">This is where it starts.</p>
            </div>

            <div className="gs-field">
              <Mail className="size-4 shrink-0 text-white/50" strokeWidth={1.8} />
              <input
                ref={inputRef}
                className="gs-input"
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && closePane()}
              />
            </div>

            <button
              type="button"
              className="gs-continue glass-neutral"
              onClick={(e) => {
                e.stopPropagation()
                closePane()
              }}>
              <span>Continue</span>
              <ArrowRight className="size-4" strokeWidth={2.2} />
            </button>

            {touched && !valid && (
              <p className="text-[11px] text-red-400 text-center">
                Enter a valid email address.
              </p>
            )}
          </div>

        {/* reveal light */}
        <div className="gs-light" onAnimationEnd={onLightAnimationEnd} />
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings: minimal hairline-divided sections under the COMPASS wordmark.
// ─────────────────────────────────────────────────────────────────────────────

// One API-key row: masked display + trash once saved, otherwise an input.
function KeyRow({
  id,
  name,
  value,
  placeholder,
  keysUrl,
  collapsible,
  collapsed,
  inputRef,
  onChange
}: {
  id: string
  name: string
  value: string
  placeholder: string
  keysUrl: string
  collapsible?: boolean
  collapsed?: boolean
  inputRef?: React.Ref<HTMLInputElement>
  onChange: (v: string) => void
}) {
  const saved = value.trim().length > 0
  return (
    <div
      id={id}
      className={`st-row ${collapsible ? "st-collapsible" : ""} ${collapsed ? "collapsed" : ""}`}>
      <div className="st-row-head">
        <span className="st-name">{name}</span>
        <a className="st-link" href={keysUrl} target="_blank" rel="noreferrer">
          Get a key ↗
        </a>
      </div>

      {saved ? (
        <div className="st-masked">
          <span className="font-mono tracking-wider">{maskKey(value)}</span>
          <button
            type="button"
            className="st-trash"
            aria-label={`Clear ${name} key`}
            onClick={() => onChange("")}>
            <Trash2 />
          </button>
        </div>
      ) : (
        <input
          ref={inputRef}
          className="st-input font-mono"
          type="text"
          spellCheck={false}
          autoComplete="off"
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  )
}

function Switch({
  checked,
  onChange,
  label
}: {
  checked: boolean
  onChange: () => void
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className={`st-switch ${checked ? "on" : ""}`}
    />
  )
}

function GithubMark() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5a12 12 0 0 0-3.79 23.4c.6.11.82-.26.82-.58v-2.02c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.5.99.11-.78.42-1.3.76-1.6-2.67-.3-5.47-1.34-5.47-5.96 0-1.32.47-2.39 1.24-3.23-.13-.3-.54-1.53.11-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.65 1.65.24 2.88.12 3.18.77.84 1.23 1.91 1.23 3.23 0 4.63-2.8 5.65-5.48 5.95.43.37.81 1.1.81 2.22v3.29c0 .32.22.7.83.58A12 12 0 0 0 12 .5Z" />
    </svg>
  )
}

// Custom dropdown for the voice choice — the native <select> can't be styled
// (its popup is OS-rendered), so this is a small controlled menu matching the
// settings design: a trigger + a dark popover list.
const VOICE_OPTIONS: { value: VoiceGender; label: string }[] = [
  { value: "female", label: "Female" },
  { value: "male", label: "Male" }
]

function VoiceSelect({
  value,
  onChange
}: {
  value: VoiceGender
  onChange: (v: VoiceGender) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const current = VOICE_OPTIONS.find((o) => o.value === value) ?? VOICE_OPTIONS[0]

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false)
    document.addEventListener("mousedown", onDoc)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDoc)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex h-[2.1rem] w-[7.5rem] items-center justify-between gap-2 rounded-[0.55rem] border border-white/[0.14] bg-white/[0.05] pl-3 pr-2.5 text-[12.5px] text-white/90 transition hover:border-white/25 focus:border-emerald-500/60 focus:outline-none">
        {current.label}
        <ChevronDown
          className={`size-3.5 text-white/45 transition-transform ${open ? "rotate-180" : ""}`}
          strokeWidth={2.5}
        />
      </button>

      {open && (
        <ul
          role="listbox"
          className="absolute right-0 z-30 mt-1.5 w-[7.5rem] overflow-hidden rounded-[0.6rem] border border-white/10 bg-neutral-900/95 py-1 shadow-xl shadow-black/50 backdrop-blur">
          {VOICE_OPTIONS.map((o) => {
            const selected = o.value === value
            return (
              <li key={o.value} role="option" aria-selected={selected}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(o.value)
                    setOpen(false)
                  }}
                  className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-[12.5px] transition ${
                    selected ? "text-emerald-300" : "text-white/85 hover:bg-white/[0.06]"
                  }`}>
                  {o.label}
                  {selected && <Check className="size-3.5" strokeWidth={2.5} />}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function Settings({
  creds,
  update,
  geminiInputRef,
  claudeInputRef
}: {
  creds: Credentials
  update: (patch: Partial<Credentials>) => void
  geminiInputRef?: React.Ref<HTMLInputElement>
  claudeInputRef?: React.Ref<HTMLInputElement>
}) {
  return (
    <div className="gs-settings gs-settings-in px-6 pb-10 font-sans">
      <section className="st-section">
        <div className="st-eyebrow">API keys</div>

        <KeyRow
          id="key-field-gemini"
          name="Gemini"
          value={creds.geminiKey}
          placeholder="AIza…"
          keysUrl={GEMINI_KEYS_URL}
          inputRef={geminiInputRef}
          onChange={(v) => update({ geminiKey: v })}
        />

        <KeyRow
          id="key-field-claude"
          name="Claude"
          value={creds.claudeKey}
          placeholder="sk-ant-…"
          keysUrl={CLAUDE_KEYS_URL}
          collapsible
          collapsed={!creds.webAutomation}
          inputRef={claudeInputRef}
          onChange={(v) => update({ claudeKey: v })}
        />
      </section>

      <section className="st-section">
        <div className="st-eyebrow">Capabilities</div>

        <div className="st-toggle-row">
          <div className="st-toggle-copy">
            <span className="st-name">Voice</span>
            <span className="st-hint">The voice Compass speaks with.</span>
          </div>
          <VoiceSelect
            value={creds.voice}
            onChange={(v) => update({ voice: v })}
          />
        </div>

        <div className="st-toggle-row">
          <div className="st-toggle-copy">
            <span className="st-name">
              Web automation <span className="st-beta font-orbitron">beta</span>
            </span>
            <span className="st-hint">
              Let Compass act on the page for you. Requires a Claude key.
            </span>
          </div>
          <Switch
            checked={creds.webAutomation}
            onChange={() => update({ webAutomation: !creds.webAutomation })}
            label="Web automation"
          />
        </div>

        <div className="st-toggle-row">
          <div className="st-toggle-copy">
            <span className="st-name">Show pill on pages</span>
            <span className="st-hint">Turn off to hide Compass without uninstalling it.</span>
          </div>
          <Switch
            checked={creds.pillEnabled}
            onChange={() => update({ pillEnabled: !creds.pillEnabled })}
            label="Show pill on pages"
          />
        </div>
      </section>

      <a className="st-github" href={REPO_URL} target="_blank" rel="noreferrer">
        <GithubMark />
        <span>Inspect the open-source code</span>
      </a>

      <p className="st-foot">
        Your keys stay in this browser. They're sent to our server only to make your own API calls,
        and are never stored or logged.
      </p>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

function SidePanel() {
  const [creds, setCreds] = useState<Credentials | null>(null)
  const { error, dismiss } = useSessionError()
  const geminiInputRef = useRef<HTMLInputElement>(null)
  const claudeInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    getCredentials().then(setCreds)
  }, [])

  // Esc dismisses the error modal.
  useEffect(() => {
    if (!error) return
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && dismiss()
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [error, dismiss])

  const update = (patch: Partial<Credentials>) => {
    setCredentials(patch).then(setCreds)
  }

  // "Update key" from the modal: dismiss, then scroll the provider's field into
  // view and focus its input (present only when the key isn't already saved).
  const onFixKey = (provider: "gemini" | "claude") => {
    dismiss()
    requestAnimationFrame(() => {
      const el = document.getElementById(`key-field-${provider}`)
      el?.scrollIntoView({ behavior: "smooth", block: "center" })
      const ref = provider === "gemini" ? geminiInputRef : claudeInputRef
      ref.current?.focus()
    })
  }

  // Retry from the mic popup: re-request the mic here (triggers the browser
  // prompt). On success, dismiss — the user can start from the pill. On failure,
  // the stashed error stays, so the popup remains.
  const onRetryMic = () => {
    navigator.mediaDevices
      ?.getUserMedia({ audio: true })
      .then((stream) => {
        stream.getTracks().forEach((t) => t.stop()) // release immediately
        dismiss()
      })
      .catch(() => {
        /* still blocked/absent — leave the popup up */
      })
  }

  const modal = (
    <ErrorModal error={error} onDismiss={dismiss} onFixKey={onFixKey} onRetryMic={onRetryMic} />
  )

  if (!creds) return <div className="h-screen bg-neutral-950" />

  const signedUp = isSignedUp(creds)

  // The giant COMPASS wordmark is a persistent header across BOTH views; only
  // the content below it swaps between onboarding and settings.
  return (
    <div className="relative overflow-y-auto w-full max-w-[400px] mx-auto h-screen flex flex-col bg-neutral-950 text-white/90">
      <p className="glass-text font-excessive text-[23rem] leading-[0.85] shrink-0 overflow-hidden tracking-[-0.4rem] mt-5 text-center">
        COMPASS
      </p>

      {signedUp ? (
        <>
          <Settings
            creds={creds}
            update={update}
            geminiInputRef={geminiInputRef}
            claudeInputRef={claudeInputRef}
          />
          {modal}
        </>
      ) : (
        // Onboarding: no error popup here — there's no key to fix yet.
        <Onboarding onDone={(email) => update({ email })} />
      )}
    </div>
  )
}

export default SidePanel
