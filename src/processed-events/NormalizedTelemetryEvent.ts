import type { TelemetryEvent } from "../telemetry/TelemetryEvent.js";

export interface NormalizedTelemetryEvent extends TelemetryEvent {
    receivedAt: string;
    durationMs: number;
}
