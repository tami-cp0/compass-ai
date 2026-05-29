import type { ServerMessage } from "./messages";
export interface QueuedTask {
    taskId: string;
    type: "automation" | "research";
    description: string;
    queuedReason: string;
    queuedAt: number;
}
export interface ActiveTask {
    type: "automation" | "research";
    description: string;
}
export interface SessionState {
    sessionId: string;
    send: (msg: ServerMessage) => void;
    automationState: "idle" | "running" | "paused" | "cancelled";
    currentTaskId: string | null;
    currentAutomationDescription: string | null;
    isResearching: boolean;
    researchDescription: string | null;
    activeTasks: Map<string, ActiveTask>;
    taskQueue: QueuedTask[];
}
//# sourceMappingURL=session.d.ts.map