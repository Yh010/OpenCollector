export type TelemetryEventType =
    | "run"
    | "agent_step"
    | "generation"
    | "tool"
    | "error";

export interface TelemetryEvent {
    eventId: string;
    runId: string;
    spanId: string;
    parentSpanId?: string;
    type: TelemetryEventType;
    name: string;
    startedAt: string;
    endedAt: string;
    status: "ok" | "error";
    metadata?: Record<string, unknown>;
}

export interface TelemetryBatch {
    events: TelemetryEvent[];
}
