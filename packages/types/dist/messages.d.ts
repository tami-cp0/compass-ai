export type ExtensionMessage = {
    type: "transcript_input";
    sessionId: string;
    text: string;
    isFinal: boolean;
} | {
    type: "audio_chunk";
    sessionId: string;
    data: string;
    mimeType: string;
} | {
    type: "dom_snapshot";
    sessionId: string;
    taskType: DomTaskType;
    payload: string;
} | {
    type: "action_result";
    sessionId: string;
    actionId: string;
    taskId: string;
    success: boolean;
    error?: string;
} | {
    type: "automation_status";
    sessionId: string;
    taskId: string;
    state: "running" | "paused" | "cancelled";
} | {
    type: "user_action_result";
    sessionId: string;
    actionId: string;
    taskId: string;
    confirmed: boolean;
};
export type ServerMessage = {
    type: "transcript";
    sessionId: string;
    text: string;
    isFinal: boolean;
} | {
    type: "speech_audio";
    sessionId: string;
    data: string;
    mimeType: "audio/mp3";
    isFinal: boolean;
} | {
    type: "action";
    sessionId: string;
    actionId: string;
    taskId: string;
    kind: ActionKind;
    target: ActionTarget;
} | {
    type: "dom_snapshot_request";
    sessionId: string;
    taskId: string;
    taskType: DomTaskType;
} | {
    type: "automation_start";
    sessionId: string;
    taskId: string;
    description: string;
} | {
    type: "automation_pause";
    sessionId: string;
    taskId: string;
} | {
    type: "automation_resume";
    sessionId: string;
    taskId: string;
} | {
    type: "automation_cancel";
    sessionId: string;
    taskId: string;
} | {
    type: "automation_end";
    sessionId: string;
    taskId: string;
    reason: "complete" | "cancelled" | "error";
    error?: string;
} | {
    type: "automation_progress";
    sessionId: string;
    taskId: string;
    description: string;
} | {
    type: "research_chunk";
    sessionId: string;
    taskId: string;
    text: string;
    isFinal: boolean;
} | {
    type: "user_action_required";
    sessionId: string;
    actionId: string;
    taskId: string;
    description: string;
};
export type DomTaskType = "click" | "form" | "read" | "structure";
export type ActionKind = "click" | "type" | "scroll";
export interface ActionTarget {
    selector?: string;
    coords?: {
        x: number;
        y: number;
    };
}
//# sourceMappingURL=messages.d.ts.map