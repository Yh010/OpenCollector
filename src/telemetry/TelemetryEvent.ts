export type TelemetryEventType =
    | "run"
    | "agent_step"
    | "generation"
    | "tool"
    | "error";

export interface LlmTelemetry {
    provider?: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    totalDurationNs?: number;
    promptEvalDurationNs?: number;
    evalDurationNs?: number;
}

export interface TelemetryEvent {
    userId?: string;
    installationId?: string;
    sessionId?: string;
    chatId?: string;
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
    llm?: LlmTelemetry;
}

export interface TelemetryBatch {
    events: TelemetryEvent[];
}
