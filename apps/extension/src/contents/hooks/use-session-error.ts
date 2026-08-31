import { useEffect, useState } from "react"

// Machine-readable session error the panel renders as a popup. Two sources
// stash it in storage.local: the background on a provider session_error
// (credits/invalid_key/missing_key), and the pill on a client-side microphone
// failure (mic_denied/mic_missing — no provider).
export interface StashedSessionError {
  reason: string
  kind: "credits" | "invalid_key" | "missing_key" | "mic_denied" | "mic_missing" | "other"
  provider: "gemini" | "claude" | null
  at: number
}

// Must match SESSION_ERROR_KEY in background.ts + use-session-error.ts.
export const SESSION_ERROR_STORAGE_KEY = "compass:lastSessionError"

// Stash a client-side error (mic failure, or a missing key the pill catches
// before the session is sent) so the side panel pops it. Mirrors what the
// background does for provider errors. `provider` is set for key errors, null
// for mic errors.
export async function stashClientError(
  kind: StashedSessionError["kind"],
  reason: string,
  provider: StashedSessionError["provider"] = null
): Promise<void> {
  await chrome.storage.local.set({
    [SESSION_ERROR_STORAGE_KEY]: { reason, kind, provider, at: Date.now() }
  })
}

// Clear any stashed error (so a stale popup doesn't cover the onboarding view).
export async function clearStashedError(): Promise<void> {
  await chrome.storage.local.remove(SESSION_ERROR_STORAGE_KEY)
}

const SESSION_ERROR_KEY = SESSION_ERROR_STORAGE_KEY

// Surfaces the latest stashed session error to the side panel and lets it be
// dismissed. Reads any error present at mount (the panel may have been opened by
// the background in response to the error), then tracks storage changes so a new
// error while the panel is open pops the modal too.
export function useSessionError(): {
  error: StashedSessionError | null
  dismiss: () => void
} {
  const [error, setError] = useState<StashedSessionError | null>(null)

  useEffect(() => {
    chrome.storage.local.get(SESSION_ERROR_KEY).then((stored) => {
      const e = stored[SESSION_ERROR_KEY] as StashedSessionError | undefined
      if (e) setError(e)
    })

    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string
    ) => {
      if (area !== "local" || !changes[SESSION_ERROR_KEY]) return
      const next = changes[SESSION_ERROR_KEY].newValue as StashedSessionError | undefined
      // A cleared key (dismiss) sets newValue undefined — don't reopen on that.
      if (next) setError(next)
    }
    chrome.storage.onChanged.addListener(onChanged)
    return () => chrome.storage.onChanged.removeListener(onChanged)
  }, [])

  const dismiss = () => {
    setError(null)
    // Clear the stash so re-opening the panel later doesn't resurface it.
    void chrome.storage.local.remove(SESSION_ERROR_KEY)
  }

  return { error, dismiss }
}
