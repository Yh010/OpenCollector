import type { TelemetryEvent } from "../telemetry/TelemetryEvent.js";

export interface RawTelemetryBatch {
    batchId: string;
    receivedAt: string;
    events: TelemetryEvent[];
}
