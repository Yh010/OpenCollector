import type { TelemetryBatch, TelemetryEvent, TelemetryEventType } from "./TelemetryEvent.js";

const eventTypes: readonly TelemetryEventType[] = [
    "run",
    "agent_step",
    "generation",
    "tool",
    "error",
];

export function parseTelemetryBatch(value: unknown): TelemetryBatch | undefined {
    if (!isRecord(value) || !Array.isArray(value.events)) {
        return undefined;
    }

    const events = value.events.map(parseTelemetryEvent);
    if (events.some((event) => event === undefined)) {
        return undefined;
    }

    return { events: events as TelemetryEvent[] };
}

function parseTelemetryEvent(value: unknown): TelemetryEvent | undefined {
    if (!isRecord(value)) {
        return undefined;
    }

    const requiredFields = ["eventId", "runId", "spanId", "name", "startedAt", "endedAt"];
    if (!requiredFields.every((field) => isNonEmptyString(value[field]))) {
        return undefined;
    }

    if (!eventTypes.includes(value.type as TelemetryEventType)) {
        return undefined;
    }

    if (value.status !== "ok" && value.status !== "error") {
        return undefined;
    }

    if (value.parentSpanId !== undefined && !isNonEmptyString(value.parentSpanId)) {
        return undefined;
    }

    if (value.metadata !== undefined && !isRecord(value.metadata)) {
        return undefined;
    }

    return value as unknown as TelemetryEvent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}
