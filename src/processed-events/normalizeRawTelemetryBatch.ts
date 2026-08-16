import type { RawTelemetryBatch } from "../raw-events/RawTelemetryBatch.js";
import type { NormalizedTelemetryEvent } from "./NormalizedTelemetryEvent.js";

export function normalizeRawTelemetryBatch(rawBatch: RawTelemetryBatch): NormalizedTelemetryEvent[] {
    return rawBatch.events.map((event) => ({
        ...event,
        receivedAt: rawBatch.receivedAt,
        durationMs: calculateDurationMs(event.startedAt, event.endedAt),
    }));
}

function calculateDurationMs(startedAt: string, endedAt: string): number {
    const startedAtMs = Date.parse(startedAt);
    const endedAtMs = Date.parse(endedAt);

    if (Number.isNaN(startedAtMs) || Number.isNaN(endedAtMs) || endedAtMs < startedAtMs) {
        throw new Error("Telemetry event has invalid timestamps");
    }

    return endedAtMs - startedAtMs;
}
