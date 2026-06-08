import type { BarsMode } from "../components/frequency-bars"
import type { ConnectionStatus } from "../hooks/use-session"

// Mutually exclusive visual states. Anything not listed is wrong.
export type PillState =
  | "default"      // idle, network ok
  | "offline"      // network down (whether from idle click or mid-session drop)
  | "slow"         // active session + uplink degraded (or briefly disconnected)
  | "active"       // active session + healthy

export interface PillViewInputs {
  active:           boolean
  wantSession:      boolean
  isOffline:        boolean
  offlineFlash:     boolean
  showActive:       boolean
  degradedAged:     boolean
  connectionStatus: ConnectionStatus
}

export interface PillView {
  pillState:       PillState
  isReconnecting:  boolean
  showBarsLayout:  boolean
  barsMode:        BarsMode
  activeLabel:     string
  widthClass:      string
  tintClass:       string
}

export function derivePillView(input: PillViewInputs): PillView {
  const { active, wantSession, isOffline, offlineFlash, showActive, degradedAged, connectionStatus } = input

  // wantSession (not active) drives the in-session layout — capture may be
  // paused due to offline while the user still wants the session.
  const pillState: PillState =
    isOffline || offlineFlash                                                                ? "offline"
    : wantSession && (connectionStatus === "degraded" || connectionStatus === "disconnected") ? "slow"
    : wantSession                                                                              ? "active"
    : "default"

  const isReconnecting = pillState === "slow" && (degradedAged || connectionStatus === "disconnected")

  const showBarsLayout = pillState === "active" || pillState === "slow" || (pillState === "offline" && wantSession)

  // Bars animate only when truly active+ok; flatline elsewhere inside the bars
  // layout. Idle offline flash uses the icon layout, so barsMode stays "idle".
  const barsMode: BarsMode =
    pillState === "active" && active && showActive                                  ? "mic"
    : showActive && (pillState === "slow" || (pillState === "offline" && wantSession)) ? "flatline"
    : "idle"

  const activeLabel =
    pillState === "offline" ? "you are offline"
    : isReconnecting        ? "reconnecting"
    : pillState === "slow"  ? "slow network"
    : "listening"

  const widthClass =
    pillState === "offline" && wantSession ? "w-[200px]" // bars + "you are offline"
    : pillState === "offline"              ? "w-[165px]" // icon + "you are offline"
    : isReconnecting                       ? "w-[140px]" // spinner + "reconnecting"
    : pillState === "slow"                 ? "w-[180px]" // bars + "slow network"
    : pillState === "active"               ? "w-[170px]" // bars + "listening"
    : "w-[130px]"                                        // icon + "Compass"

  const tintClass =
    pillState === "offline" ? "offline"
    : pillState === "slow"  ? "degraded"
    : pillState === "active" ? "active"
    : ""

  return { pillState, isReconnecting, showBarsLayout, barsMode, activeLabel, widthClass, tintClass }
}
