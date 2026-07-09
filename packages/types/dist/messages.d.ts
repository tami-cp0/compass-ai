export type ExtensionMessage = {
    type: "session_start";
} | {
    type: "session_resume";
    sessionId: string;
} | {
    type: "session_end";
} | {
    type: "audio_chunk";
    sessionId: string;
    data: string;
    mimeType: "audio/pcm";
} | {
    type: "screenshot_response";
    sessionId: string;
    requestId: string;
    dataUrl: string;
} | {
    type: "page_data_response";
    sessionId: string;
    requestId: string;
    data: string;
    truncated: boolean;
    error?: string;
} | {
    type: "agent_observation";
    sessionId: string;
    taskId: string;
    screenshot: string;
    width: number;
    height: number;
    url: string;
    title: string;
    scrollRegions?: ScrollRegion[];
} | {
    type: "agent_action_result";
    sessionId: string;
    taskId: string;
    actionId: string;
    success: boolean;
    error?: string;
};
export type ServerMessage = {
    type: "audio_chunk";
    sessionId: string;
    data: string;
    mimeType: "audio/pcm";
} | {
    type: "session_init";
    sessionId: string;
} | {
    type: "screenshot_request";
    sessionId: string;
    requestId: string;
} | {
    type: "page_data_request";
    sessionId: string;
    requestId: string;
    box: Box;
    physicalPixels: boolean;
} | {
    type: "research_status";
    sessionId: string;
    taskId: string;
    name: string;
    status: "started" | "completed" | "failed" | "cancelled";
} | {
    type: "connection_status";
    status: "ok" | "degraded" | "disconnected";
} | {
    type: "pin_pane_set";
    sessionId: string;
    title: string;
    markdown: string;
    width: number;
    height: number;
    columns?: number;
    links?: PaneLink[];
} | {
    type: "pin_pane_clear";
    sessionId: string;
} | {
    type: "pin_pane_minimize";
    sessionId: string;
} | {
    type: "agent_observation_request";
    sessionId: string;
    taskId: string;
} | {
    type: "agent_action";
    sessionId: string;
    taskId: string;
    actionId: string;
    action: AgentAction;
} | {
    type: "automation_end";
    sessionId: string;
    taskId: string;
    reason: "complete" | "cancelled" | "error";
    error?: string;
};
export interface PaneLink {
    url: string;
    title: string;
    platform?: string;
}
export interface ScrollRegion {
    x: number;
    y: number;
    width: number;
    height: number;
    canScrollDown: boolean;
    canScrollUp: boolean;
    canScrollLeft: boolean;
    canScrollRight: boolean;
    label?: string;
}
export interface Box {
    x: number;
    y: number;
    width: number;
    height: number;
}
export type AgentAction = {
    variant: "mouse:click";
    x: number;
    y: number;
} | {
    variant: "mouse:double_click";
    x: number;
    y: number;
} | {
    variant: "mouse:right_click";
    x: number;
    y: number;
} | {
    variant: "mouse:drag";
    from: {
        x: number;
        y: number;
    };
    to: {
        x: number;
        y: number;
    };
} | {
    variant: "mouse:scroll";
    x: number;
    y: number;
    deltaX: number;
    deltaY: number;
} | {
    variant: "keyboard:type";
    content: string;
} | {
    variant: "keyboard:enter";
} | {
    variant: "keyboard:tab";
} | {
    variant: "keyboard:backspace";
} | {
    variant: "keyboard:select_all";
} | {
    variant: "browser:nav";
    url: string;
} | {
    variant: "browser:nav:back";
} | {
    variant: "browser:tab:switch";
    index: number;
} | {
    variant: "browser:tab:new";
} | {
    variant: "wait";
    seconds: number;
} | {
    variant: "page:read";
    x: number;
    y: number;
    width: number;
    height: number;
} | {
    variant: "task:done";
    evidence: string;
} | {
    variant: "task:fail";
    reason: string;
};
export type ActionVariant = AgentAction["variant"];
export interface AgentActionResult {
    variant: ActionVariant;
    result: "ok" | "failed";
    error?: string;
    data?: string;
}
export interface AgentStep {
    reasoning: string;
    progress_note: string;
    page_changed: boolean;
    actions: AgentAction[];
}
//# sourceMappingURL=messages.d.ts.map