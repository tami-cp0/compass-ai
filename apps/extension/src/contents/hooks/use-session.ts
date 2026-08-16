import type { ExtensionMessage, ServerMessage } from "@compass-ai/types"
import { useCallback, useEffect, useRef, useState } from "react"

import { PcmCapture } from "~/audio/pcm-capture"

import { player } from "../lib/audio-runtime"
import { canStartSession, CREDENTIALS_KEY, getCredentials, isValidEmail, sessionKeys, voiceName, type Credentials } from "../lib/credentials"
import { clearStashedError, SESSION_ERROR_STORAGE_KEY, stashClientError } from "./use-session-error"

type StripSessionId<T> = T extends { sessionId: string } ? Omit<T, "sessionId"> : T
type OutboundExtensionMessage = StripSessionId<ExtensionMessage>

export type ConnectionStatus = "ok" | "degraded" | "disconnected"

export interface ResearchTask {
  taskId: string
  name:   string
  status: "started" | "completed" | "failed" | "cancelled"
}

export interface UseSession {
  active:              boolean
  // True when the user wants a session, even if we've torn down capture due
  // to offline. Used by the UI to keep showing the "in-session" layout.
  wantSession:         boolean
  isAutomationRunning: boolean
  researchTasks:       ResearchTask[]
  // The live agent has its vision (continuous screen view) turned on.
  isVisionOn:          boolean
  connectionStatus:    ConnectionStatus
  isOffline:           boolean
  // Set when a start attempt was blocked (missing keys) or the server rejected
  // the session (session_error). Cleared on the next successful start.
  sessionError:        string | null
  // True while an error popup is stashed but the panel hasn't shown it yet. The
  // pill renders a "click me" badge; clicking opens the panel (a user gesture).
  errorPending:        boolean
  pillEnabled:         boolean
  toggle:              () => void
}

// Orchestrates a Compass voice session: PCM capture lifecycle, background
// runtime messaging, and the automation state surfaced through inbound
// ServerMessages.
export function useSession(): UseSession {
  const [active,              setActive]              = useState(false)
  const [isAutomationRunning, setIsAutomationRunning] = useState(false)
  const [researchTasks,       setResearchTasks]       = useState<ResearchTask[]>([])
  const [isVisionOn,          setIsVisionOn]          = useState(false)
  const [connectionStatus,    setConnectionStatus]    = useState<ConnectionStatus>("ok")
  const [isOffline,           setIsOffline]           = useState(typeof navigator !== "undefined" && !navigator.onLine)
  const [wantSession,         setWantSession]         = useState(false)
  const [sessionError,        setSessionError]        = useState<string | null>(null)
  const [errorPending,        setErrorPending]        = useState(false)
  const [pillEnabled,         setPillEnabled]         = useState(true)
  const captureRef = useRef<PcmCapture | null>(null)
  // Holds the latest teardownCapture so the mount-time message listener (which
  // closes over nothing) can tear down capture on a session_error.
  const teardownCaptureRef = useRef<(() => void) | null>(null)
  // Latest credentials, kept in a ref so the click handler can decide
  // synchronously (within the user gesture) whether setup is incomplete — needed
  // because chrome.sidePanel.open() must run inside the gesture, before awaits.
  const credsRef = useRef<Credentials | null>(null)

  // Keep the pill's error badge in sync with the stashed error: present → badge
  // on, removed (panel dismissed it) → badge off. Covers errors stashed by the
  // pill itself and by the background (server-pushed).
  useEffect(() => {
    chrome.storage.local
      .get(SESSION_ERROR_STORAGE_KEY)
      .then((s) => setErrorPending(!!s[SESSION_ERROR_STORAGE_KEY]))
    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string
    ) => {
      if (area !== "local" || !changes[SESSION_ERROR_STORAGE_KEY]) return
      setErrorPending(!!changes[SESSION_ERROR_STORAGE_KEY].newValue)
    }
    chrome.storage.onChanged.addListener(onChanged)
    return () => chrome.storage.onChanged.removeListener(onChanged)
  }, [])

  useEffect(() => {
    const onOnline  = () => setIsOffline(false)
    const onOffline = () => setIsOffline(true)
    window.addEventListener("online",  onOnline)
    window.addEventListener("offline", onOffline)
    return () => {
      window.removeEventListener("online",  onOnline)
      window.removeEventListener("offline", onOffline)
    }
  }, [])

  useEffect(() => {
    const onMessage = (msg: ServerMessage) => {
      if (msg.type === "audio_chunk") {
        player.resume()
        player.play(msg.data)
        return false
      }
      // Either an action dispatch or an observation request is enough to
      // know the agent is actively driving the page.
      if (msg.type === "agent_action" || msg.type === "agent_observation_request") {
        setIsAutomationRunning(true)
        return false
      }
      if (msg.type === "automation_end") {
        setIsAutomationRunning(false)
        return false
      }
      if (msg.type === "research_status") {
        setResearchTasks((prev) => {
          if (msg.status === "started") {
            if (prev.some((t) => t.taskId === msg.taskId)) return prev
            return [...prev, { taskId: msg.taskId, name: msg.name, status: "started" }]
          }
          return prev.map((t) => (t.taskId === msg.taskId ? { ...t, status: msg.status } : t))
        })
        // End states just fade out (400ms animation), then drop.
        if (msg.status !== "started") {
          setTimeout(() => {
            setResearchTasks((prev) => prev.filter((t) => t.taskId !== msg.taskId))
          }, 500)
        }
        return false
      }
      if (msg.type === "vision_start") {
        setIsVisionOn(true)
        return false
      }
      if (msg.type === "vision_stop") {
        setIsVisionOn(false)
        return false
      }
      if (msg.type === "session_error") {
        // Server refused/killed the session (bad key, out of credits, etc). Drop
        // the session and raise the "click me" error badge on the pill: the SW
        // can't auto-open the side panel for a server-pushed error (no user
        // gesture), so the pill click is how the user opens the panel to see the
        // stashed popup.
        setSessionError(msg.reason)
        setErrorPending(true)
        setWantSession(false)
        setResearchTasks([])
        setIsVisionOn(false)
        teardownCaptureRef.current?.()
        return false
      }
      if (msg.type === "connection_status") {
        setConnectionStatus(msg.status)
        // Server can't deliver automation_end or research_status through a
        // dead socket, so the UI would otherwise stay stuck on running
        // indicators forever.
        if (msg.status === "disconnected") {
          setIsAutomationRunning(false)
          setResearchTasks([])
          setIsVisionOn(false)
        }
        return false
      }
      return false
    }
    chrome.runtime.onMessage.addListener(onMessage)
    return () => chrome.runtime.onMessage.removeListener(onMessage)
  }, [])

  // Internal: stop mic capture only. Does NOT send session_end — the server
  // keeps the Gemini resumption handle alive so we can resume on reconnect.
  const teardownCapture = useCallback(() => {
    captureRef.current?.stop()
    captureRef.current = null
    player.stop()
    setActive(false)
  }, [])

  // Keep the ref pointed at the latest teardownCapture so the mount-time
  // message listener can call it on session_error.
  teardownCaptureRef.current = teardownCapture

  // Attempts to start a session. Reads the user's stored credentials and gates
  // on them (Gemini always, Claude when web automation is on); if insufficient,
  // sets sessionError and returns false without starting. Otherwise attaches the
  // keys to session_start and begins mic capture. Returns whether it started.
  const startSession = useCallback(async (): Promise<boolean> => {
    const creds = await getCredentials()
    if (!canStartSession(creds)) {
      // Safety net for non-gesture callers (e.g. offline auto-resume). The
      // in-gesture path in `toggle` already opens the panel + stashes the
      // missing-key popup; here we just refuse to start.
      setSessionError("Open Compass from the toolbar to finish setup.")
      return false
    }
    setSessionError(null)
    chrome.runtime.sendMessage({
      type:          "session_start",
      keys:          sessionKeys(creds),
      webAutomation: creds.webAutomation,
      email:         creds.email,
      voiceName:     voiceName(creds),
    } as OutboundExtensionMessage)
    const capture = new PcmCapture((base64Pcm: string) => {
      chrome.runtime.sendMessage({
        type:     "audio_chunk",
        data:     base64Pcm,
        mimeType: "audio/pcm"
      } as OutboundExtensionMessage)
    })
    try {
      await capture.start()
    } catch (err) {
      // Mic denied / no device. Tear the just-started server session back down
      // (no audio is coming), stash the error so the side panel pops the mic
      // popup, and open the panel. Return false so wantSession stays false.
      chrome.runtime.sendMessage({ type: "session_end" })
      const kind =
        err instanceof DOMException && err.name === "NotFoundError"
          ? "mic_missing"
          : "mic_denied"
      // Stash the error (storage works from a content script) then ask the
      // background to open the side panel (sidePanel.open isn't available here).
      await stashClientError(kind, err instanceof Error ? err.message : String(err))
      chrome.runtime.sendMessage({ type: "open_side_panel" })
      setSessionError("Microphone unavailable.")
      return false
    }
    captureRef.current = capture
    setActive(true)
    return true
  }, [])

  // Explicit user stop: tear down mic AND tell the server, which closes the
  // Gemini session and deletes the resumption handle.
  const stopSession = useCallback(() => {
    setWantSession(false)
    setResearchTasks([])
    setIsVisionOn(false)
    chrome.runtime.sendMessage({ type: "session_end" })
    teardownCapture()
  }, [teardownCapture])

  const toggle = useCallback(() => {
    // An error popup is stashed but unseen — clicking the pill (a user gesture)
    // opens the panel so Chrome allows it. Don't start a session on this click.
    // Drop the badge immediately as the panel opens (the popup itself now
    // carries the message); the stash stays until the popup is dismissed.
    if (errorPending) {
      chrome.runtime.sendMessage({ type: "open_side_panel" })
      setErrorPending(false)
      return
    }
    if (wantSession) {
      stopSession()
      return
    }

    // Setup-incomplete check runs SYNCHRONOUSLY here (from the click's user
    // gesture) using the cached creds. Content scripts can't call
    // chrome.sidePanel directly, so we message the SW to open it — but the
    // message MUST be sent inside the gesture (before any await) or Chrome
    // rejects the open. We re-validate in startSession for async callers.
    const creds = credsRef.current
    if (creds && !canStartSession(creds)) {
      // Fire the open first, still in-gesture.
      chrome.runtime.sendMessage({ type: "open_side_panel" })
      setSessionError("Open Compass from the toolbar to finish setup.")

      const signedUp = isValidEmail(creds.email)
      if (signedUp) {
        // Onboarded, just missing a key → stash a popup naming the provider.
        const missing =
          !creds.geminiKey.trim() ? "gemini"
          : creds.webAutomation && !creds.claudeKey.trim() ? "claude"
          : null
        if (missing) {
          void stashClientError(
            "missing_key",
            `${missing === "gemini" ? "Gemini" : "Claude"} API key is not set.`,
            missing
          )
        }
      } else {
        // Not signed up yet — no key popup. Opening the panel shows onboarding;
        // clear any stale stashed error so a popup doesn't cover the pill.
        void clearStashedError()
      }
      return
    }

    // Unlock the audio output NOW, while the click gesture is active. Incoming
    // Gemini audio arrives after the async handshake (no gesture), so without
    // this the AudioContext stays suspended under Chrome's autoplay policy and
    // playback is silent.
    player.prime()

    // Only enter the wanted-session state if the start actually began (keys
    // present). A blocked start sets sessionError and leaves wantSession false
    // so offline auto-resume can't loop on it.
    startSession()
      .then((started) => {
        if (started) setWantSession(true)
      })
      .catch(console.error)
  }, [wantSession, errorPending, startSession, stopSession])

  const stopIfActiveRef = useRef<() => void>(() => {})
  stopIfActiveRef.current = () => { if (wantSession) stopSession() }

  // Restart an active session in place: stop, then start again with the latest
  // credentials. Used when a setting changes that's baked into the session at
  // connect time (e.g. voice) but the user shouldn't have to re-click the pill.
  const restartIfActiveRef = useRef<() => void>(() => {})
  restartIfActiveRef.current = () => {
    if (!wantSession) return
    stopSession()
    // Let the stop settle (session_end sent, capture torn down) before starting
    // fresh; the new session picks up the changed setting from storage.
    setTimeout(() => {
      startSession()
        .then((started) => setWantSession(started))
        .catch(console.error)
    }, 250)
  }

  useEffect(() => {
    getCredentials().then((c) => {
      setPillEnabled(c.pillEnabled)
      credsRef.current = c
    })
    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string
    ) => {
      if (area !== "local" || !changes[CREDENTIALS_KEY]) return
      const change = changes[CREDENTIALS_KEY]
      const next = change.newValue as Credentials | undefined
      const prev = change.oldValue as Credentials | undefined
      if (!next) return
      credsRef.current = next
      setPillEnabled(next.pillEnabled)
      if (!next.pillEnabled) {
        stopIfActiveRef.current()
        return
      }
      // Web automation changes what the session is built with (Claude client +
      // tools). We can't mutate a live Gemini session's capabilities, so end it;
      // the user restarts and the new session is rebuilt with the new setting,
      // which is how Gemini becomes aware of the change.
      if (prev && prev.webAutomation !== next.webAutomation) {
        stopIfActiveRef.current()
        return
      }
      // Voice is baked into the Gemini connect config, so a live switch needs a
      // reconnect. Restart in place so the new voice takes effect immediately
      // without the user re-clicking the pill.
      if (prev && prev.voice !== next.voice) {
        restartIfActiveRef.current()
      }
    }
    chrome.storage.onChanged.addListener(onChanged)
    return () => chrome.storage.onChanged.removeListener(onChanged)
  }, [])

  // Auto-stop on offline; auto-resume on online only if we paused it ourselves.
  const pausedByOfflineRef = useRef(false)
  useEffect(() => {
    if (isOffline) {
      if (captureRef.current) {
        pausedByOfflineRef.current = true
        teardownCapture()
      }
      return
    }
    if (wantSession && !captureRef.current && pausedByOfflineRef.current) {
      pausedByOfflineRef.current = false
      startSession().catch(console.error)
    }
  }, [isOffline, wantSession, teardownCapture, startSession])

  return { active, wantSession, isAutomationRunning, researchTasks, isVisionOn, connectionStatus, isOffline, sessionError, errorPending, pillEnabled, toggle }
}
