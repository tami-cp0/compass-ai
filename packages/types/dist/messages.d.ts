export type ExtensionMessage = {
    type: "audio_chunk";
    sessionId: string;
    data: string;
    mimeType: "audio/pcm";
} | {
    type: "dom_snapshot";
    sessionId: string;
    taskId: string;
    taskType: DomTaskType;
    screenshot: string;
    elementMap: string;
} | {
    type: "action_result";
    sessionId: string;
    actionId: string;
    taskId: string;
    success: boolean;
    error?: string;
} | {
    type: "user_action_result";
    sessionId: string;
    actionId: string;
    taskId: string;
    confirmed: boolean;
};
export type ServerMessage = {
    type: "audio_chunk";
    sessionId: string;
    data: string;
    mimeType: "audio/pcm";
} | {
    type: "action";
    sessionId: string;
    actionId: string;
    taskId: string;
    intent: WebIntent;
    isCritical: boolean;
} | {
    type: "dom_snapshot_request";
    sessionId: string;
    taskId: string;
    taskType: DomTaskType;
} | {
    type: "automation_end";
    sessionId: string;
    taskId: string;
    reason: "complete" | "cancelled" | "error";
    error?: string;
} | {
    type: "user_action_required";
    sessionId: string;
    actionId: string;
    taskId: string;
    description: string;
} | {
    type: "session_init";
    sessionId: string;
};
export type DomTaskType = "click" | "form" | "read" | "structure";
export type WebIntent = {
    action: "click";
    element_id: number;
} | {
    action: "type";
    element_id: number;
    value: string;
} | {
    action: "scroll";
    element_id: number | null;
    direction: "up" | "down";
    amount: number;
} | {
    action: "highlight";
    element_id: number;
    text_snippet: string;
};
//# sourceMappingURL=messages.d.ts.map