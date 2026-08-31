// User-provided LLM API keys + the web-automation toggle, stored durably in
// chrome.storage.local so the user enters them once. These are read at session
// start and attached to the session_start message; they never leave the user's
// browser except as a transient per-session parameter to our own server.
//
// NOTE: chrome.storage.local is plaintext at rest (the user's own profile) —
// the standard, accepted posture for a browser extension holding the user's own
// credential. We do not attempt in-extension encryption (the key would have to
// live alongside it, which buys nothing).

export type VoiceGender = "male" | "female"

// Gemini Live prebuilt voice names for each gender option.
export const VOICE_NAMES: Record<VoiceGender, string> = {
  male: "Zubenelgenubi",
  female: "Erinome",
}

export interface Credentials {
  email: string
  geminiKey: string
  claudeKey: string
  webAutomation: boolean
  pillEnabled: boolean
  voice: VoiceGender
}

export const CREDENTIALS_KEY = "compass:credentials"
const STORAGE_KEY = CREDENTIALS_KEY

const DEFAULTS: Credentials = {
  email: "",
  geminiKey: "",
  claudeKey: "",
  webAutomation: false,
  pillEnabled: true,
  voice: "female",
}

export async function getCredentials(): Promise<Credentials> {
  const stored = await chrome.storage.local.get(STORAGE_KEY)
  return { ...DEFAULTS, ...(stored[STORAGE_KEY] as Partial<Credentials> | undefined) }
}

export async function setCredentials(patch: Partial<Credentials>): Promise<Credentials> {
  const next = { ...(await getCredentials()), ...patch }
  await chrome.storage.local.set({ [STORAGE_KEY]: next })
  return next
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
}

// A user is "signed up" once they've stored a valid email — checked to decide
// between the onboarding step and the settings view.
export function isSignedUp(creds: Credentials): boolean {
  return isValidEmail(creds.email)
}

// Whether the stored credentials are sufficient to start a session: a valid
// email and a Gemini key are always required; the Claude key is required only
// when web automation is on. This is the gating predicate for the start control.
export function canStartSession(creds: Credentials): boolean {
  if (!isValidEmail(creds.email)) return false
  if (!creds.geminiKey.trim()) return false
  if (creds.webAutomation && !creds.claudeKey.trim()) return false
  return true
}

// The keys payload for the session_start / session_resume wire message. Claude
// is included only when web automation is on.
export function sessionKeys(creds: Credentials): { gemini: string; claude?: string } {
  return creds.webAutomation
    ? { gemini: creds.geminiKey.trim(), claude: creds.claudeKey.trim() }
    : { gemini: creds.geminiKey.trim() }
}

// The Gemini Live voice name for the user's gender choice.
export function voiceName(creds: Credentials): string {
  return VOICE_NAMES[creds.voice] ?? VOICE_NAMES.female
}
