// Extension → Gateway → Node
export type ExtensionMessage =
  | { type: "session_start" }
  | { type: "session_resume"; sessionId: string }
  | { type: "session_end" }
  | { type: "audio_chunk"; sessionId: string; data: string; mimeType: "audio/pcm" }
  | { type: "dom_snapshot"; sessionId: string; taskId: string; taskType: DomTaskType; screenshot: string; elementMap: string }
  | { type: "action_result"; sessionId: string; actionId: string; taskId: string; success: boolean; error?: string }
  | { type: "user_action_result"; sessionId: string; actionId: string; taskId: string; confirmed: boolean }
  | { type: "screenshot_response"; sessionId: string; requestId: string; dataUrl: string }

// Node → Gateway → Extension
export type ServerMessage =
  | { type: "audio_chunk"; sessionId: string; data: string; mimeType: "audio/pcm" }
  | { type: "action"; sessionId: string; actionId: string; taskId: string; intent: WebIntent; isCritical: boolean }
  | { type: "dom_snapshot_request"; sessionId: string; taskId: string; taskType: DomTaskType }
  | { type: "automation_end"; sessionId: string; taskId: string; reason: "complete" | "cancelled" | "error"; error?: string }
  | { type: "user_action_required"; sessionId: string; actionId: string; taskId: string; description: string }
  | { type: "session_init"; sessionId: string }
  | { type: "screenshot_request"; sessionId: string; requestId: string }
  | { type: "connection_status"; status: "ok" | "degraded" | "disconnected" }
  | { type: "pin_pane_set"; sessionId: string; title: string; markdown: string; width: number; height: number }
  | { type: "pin_pane_clear"; sessionId: string }

export type DomTaskType = "click" | "form" | "read" | "structure"

export type PressKey = 'Enter' | 'Tab' | 'Escape' | 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'

export interface WebAction {
  action: 'click' | 'type' | 'scroll' | 'highlight' | 'press'
  element_id: number | null
  value: string | null
  direction: 'up' | 'down' | 'left' | 'right' | null
  amount: number | null
  text_snippet: string | null
  key: PressKey | null
  isCritical: boolean
  description: string
}

export interface WebAgentStep {
  reasoning: string
  next_action: WebAction | null
  is_complete: boolean
  is_failed: boolean
}

export interface StepRecord {
  step_number: number
  action_description: string
  outcome: 'succeeded' | 'failed'
  error?: string
}

export type WebIntent =
  | { action: "click"; element_id: number }
  | { action: "type"; element_id: number; value: string }
  | { action: "scroll"; element_id: number | null; direction: "up" | "down" | "left" | "right"; amount: number }
  | { action: "highlight"; element_id: number; text_snippet: string }
  | { action: "press"; element_id: number; key: PressKey }
