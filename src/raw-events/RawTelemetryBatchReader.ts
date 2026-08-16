import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { parseTelemetryBatch } from "../telemetry/validateTelemetryBatch.js";
import type { RawTelemetryBatch } from "./RawTelemetryBatch.js";

export class RawTelemetryBatchReader {
    async read(filePath: string, batchId: string): Promise<RawTelemetryBatch> {
        const stream = createReadStream(filePath, { encoding: "utf8" });
        const lines = createInterface({ input: stream, crlfDelay: Infinity });

        for await (const line of lines) {
            const batch = parseRawTelemetryBatch(line);
            if (batch?.batchId === batchId) {
                lines.close();
                stream.destroy();
                return batch;
            }
        }

        throw new Error(`Raw telemetry batch ${batchId} was not found`);
    }
}

function parseRawTelemetryBatch(line: string): RawTelemetryBatch | undefined {
    try {
        const value: unknown = JSON.parse(line);
        if (!isRecord(value) || !isNonEmptyString(value.batchId) || !isNonEmptyString(value.receivedAt)) {
            return undefined;
        }

        const telemetryBatch = parseTelemetryBatch({ events: value.events });
        if (!telemetryBatch) {
            return undefined;
        }

        return {
            batchId: value.batchId,
            receivedAt: value.receivedAt,
            events: telemetryBatch.events,
        };
    } catch {
        return undefined;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}
