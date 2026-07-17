// Extension → Gateway → Node
export type ExtensionMessage =
  | { type: "session_start" }
  | { type: "session_resume"; sessionId: string }
  | { type: "session_end" }
  | { type: "audio_chunk"; sessionId: string; data: string; mimeType: "audio/pcm" }
  | { type: "screenshot_response"; sessionId: string; requestId: string; dataUrl: string }
  | { type: "page_data_response"; sessionId: string; requestId: string; data: string; truncated: boolean; error?: string }
  | { type: "agent_observation"; sessionId: string; taskId: string; screenshot: string; width: number; height: number; cssWidth: number; cssHeight: number; url: string; title: string; scrollRegions?: ScrollRegion[] }
  | { type: "agent_action_result"; sessionId: string; taskId: string; actionId: string; success: boolean; error?: string }
  // A single frame of the live vision stream (base64 PNG, no data: prefix),
  // pushed by the extension while vision is on. Forwarded to the model as a
  // realtime video frame.
  | { type: "vision_frame"; sessionId: string; data: string }

// Node → Gateway → Extension
export type ServerMessage =
  | { type: "audio_chunk"; sessionId: string; data: string; mimeType: "audio/pcm" }
  | { type: "session_init"; sessionId: string }
  | { type: "screenshot_request"; sessionId: string; requestId: string }
  | { type: "page_data_request"; sessionId: string; requestId: string; box: Box; physicalPixels: boolean }
  | { type: "research_status"; sessionId: string; taskId: string; name: string; status: "started" | "completed" | "failed" | "cancelled" }
  | { type: "connection_status"; status: "ok" | "degraded" | "disconnected" }
  | { type: "pin_pane_set"; sessionId: string; title: string; markdown: string; width: number; height: number; columns?: number; links?: PaneLink[] }
  | { type: "pin_pane_clear"; sessionId: string }
  | { type: "pin_pane_minimize"; sessionId: string }
  | { type: "agent_observation_request"; sessionId: string; taskId: string }
  | { type: "agent_action"; sessionId: string; taskId: string; actionId: string; action: AgentAction }
  | { type: "automation_end"; sessionId: string; taskId: string; reason: "complete" | "cancelled" | "error"; error?: string }
  // Start/stop the continuous vision stream. The extension runs the frame loop
  // (adaptive cadence) between these; the pill shows a vision indicator while on.
  | { type: "vision_start"; sessionId: string }
  | { type: "vision_stop"; sessionId: string }

// A clickable source link rendered as a glass "louver" bar at the bottom of
// the pin pane. title is the page's real title; platform is the site name
// (e.g. "Nairametrics", "NGX", "Reddit").
export interface PaneLink {
  url: string
  title: string
  platform?: string
}

// A scrollable region visible in the viewport, reported with each web-agent
// observation so the agent knows — deterministically, not by guessing from a
// screenshot — whether a scroll in a given area will actually do anything.
// Coordinates are CSS pixels (the web agent's screenshot space). Note: only
// SCROLL is reported; "clickable" cannot be reliably detected from the DOM (a
// plain-looking div can carry a click handler), so it is deliberately omitted
// rather than guessed.
export interface ScrollRegion {
  x: number
  y: number
  width: number
  height: number
  canScrollDown: boolean
  canScrollUp: boolean
  canScrollLeft: boolean
  canScrollRight: boolean
  // Short hint of what the region is (nearest heading/aria-label), if any.
  label?: string
}

// A rectangle in screenshot-pixel space. Whether those pixels are physical or
// CSS depends on the caller's screenshot: the live agent's frame is physical
// resolution (physicalPixels: true → extension divides by dpr); the web agent's
// frame is already CSS pixels (physicalPixels: false → used as-is).
export interface Box {
  x: number
  y: number
  width: number
  height: number
}

// Variant-tagged action wire form. Coordinates are in CSS-pixel space.
export type AgentAction =
  | { variant: "mouse:click"; x: number; y: number }
  | { variant: "mouse:double_click"; x: number; y: number }
  | { variant: "mouse:right_click"; x: number; y: number }
  | { variant: "mouse:drag"; from: { x: number; y: number }; to: { x: number; y: number } }
  | { variant: "mouse:scroll"; x: number; y: number; deltaX: number; deltaY: number }
  | { variant: "keyboard:type"; content: string }
  | { variant: "keyboard:enter" }
  | { variant: "keyboard:tab" }
  | { variant: "keyboard:backspace" }
  | { variant: "keyboard:select_all" }
  | { variant: "browser:nav"; url: string }
  | { variant: "browser:nav:back" }
  | { variant: "browser:tab:switch"; index: number }
  | { variant: "browser:tab:new" }
  | { variant: "wait"; seconds: number }
  // Read the exact visible text inside a box (CSS-pixel coords on the agent's
  // screenshot). Returns the page's real characters — use before relying on a
  // number a screenshot might misread. The extracted text comes back on the
  // action result's `data` field.
  | { variant: "page:read"; x: number; y: number; width: number; height: number }
  | { variant: "task:done"; evidence: string }
  | { variant: "task:fail"; reason: string }

export type ActionVariant = AgentAction["variant"]
