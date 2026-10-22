import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { NormalizedEventSegmentWriter } from "./processed-events/NormalizedEventSegmentWriter.js";
import { normalizeRawTelemetryBatch } from "./processed-events/normalizeRawTelemetryBatch.js";
import { parseTelemetryBatch } from "./telemetry/validateTelemetryBatch.js";
import type { TelemetryEvent } from "./telemetry/TelemetryEvent.js";

const rawRoot = resolve(process.env.RAW_EVENTS_DIR ?? "data/raw-events");
const writer = new NormalizedEventSegmentWriter({ rootDirectory: resolve(process.env.NORMALIZED_EVENTS_DIR ?? "data/normalized-events") });
try {
    for (const file of await files(rawRoot)) {
        for (const line of (await readFile(file, "utf8")).split("\n")) {
            const batch = parseRawBatch(line);
            if (batch) await writer.write({ ...batch, events: normalizeRawTelemetryBatch(batch) });
        }
    }
    await writer.rebuildOverview();
} finally { writer.close(); }

async function files(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    return (await Promise.all(entries.map((entry) => entry.isDirectory() ? files(join(directory, entry.name)) : entry.name.endsWith(".jsonl") ? [join(directory, entry.name)] : []))).flat();
}

function parseRawBatch(line: string): { batchId: string; receivedAt: string; events: TelemetryEvent[] } | undefined {
    try {
        const value: unknown = JSON.parse(line);
        if (typeof value !== "object" || value === null || !("batchId" in value) || !("receivedAt" in value) || !("events" in value)) return undefined;
        const telemetry = parseTelemetryBatch({ events: value.events });
        return telemetry && typeof value.batchId === "string" && typeof value.receivedAt === "string" ? { batchId: value.batchId, receivedAt: value.receivedAt, events: telemetry.events } : undefined;
    } catch { return undefined; }
}
