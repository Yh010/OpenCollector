import type { NormalizedTelemetryEvent } from "../processed-events/NormalizedTelemetryEvent.js";
import type { TelemetryEventType } from "../telemetry/TelemetryEvent.js";

export interface TelemetryQuery {
    from?: string;
    to?: string;
    status?: "ok" | "error";
    type?: TelemetryEventType;
    name?: string;
    runId?: string;
}

export interface TelemetryStorage {
    listEvents(query: TelemetryQuery): Promise<NormalizedTelemetryEvent[]>;
}
