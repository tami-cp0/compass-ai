// Extension → Gateway → Node
export type ExtensionMessage =
  | { type: "session_start" }
  | { type: "session_resume"; sessionId: string }
  | { type: "session_end" }
  | { type: "audio_chunk"; sessionId: string; data: string; mimeType: "audio/pcm" }
  | { type: "screenshot_response"; sessionId: string; requestId: string; dataUrl: string }
  | { type: "agent_observation"; sessionId: string; taskId: string; screenshot: string; width: number; height: number; url: string; title: string }
  | { type: "agent_action_result"; sessionId: string; taskId: string; actionId: string; success: boolean; error?: string }
  // Dev-only: dispatched from the service-worker console via __runWebAgent
  // / __cancelWebAgent. The API ignores these in production.
  | { type: "agent_dispatch_debug"; sessionId: string; name: string; description: string }
  | { type: "agent_cancel_debug"; sessionId: string; name: string }

// Node → Gateway → Extension
export type ServerMessage =
  | { type: "audio_chunk"; sessionId: string; data: string; mimeType: "audio/pcm" }
  | { type: "session_init"; sessionId: string }
  | { type: "screenshot_request"; sessionId: string; requestId: string }
  | { type: "connection_status"; status: "ok" | "degraded" | "disconnected" }
  | { type: "pin_pane_set"; sessionId: string; title: string; markdown: string; width: number; height: number }
  | { type: "pin_pane_clear"; sessionId: string }
  | { type: "agent_observation_request"; sessionId: string; taskId: string }
  | { type: "agent_action"; sessionId: string; taskId: string; actionId: string; action: AgentAction }
  | { type: "automation_end"; sessionId: string; taskId: string; reason: "complete" | "cancelled" | "error"; error?: string }

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
  | { variant: "task:done"; evidence: string }
  | { variant: "task:fail"; reason: string }

export type ActionVariant = AgentAction["variant"]

// Result the API attaches to the next observation so the model knows what
// just happened on each action it emitted.
export interface AgentActionResult {
  variant: ActionVariant
  result: "ok" | "failed"
  error?: string
}

// One reasoning + action plan from the step planner.
export interface AgentStep {
  reasoning: string
  // One-line post-action observation describing what visibly changed on the
  // page (or "no change"). Surfaced to the orchestrating model as the
  // automation's externalized progress log; reasoning stays internal.
  progress_note: string
  actions: AgentAction[]
}
