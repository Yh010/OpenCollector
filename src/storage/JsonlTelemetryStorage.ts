import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { NormalizedTelemetryBatch } from "../processed-events/NormalizedEventSegmentWriter.js";
import type { NormalizedTelemetryEvent } from "../processed-events/NormalizedTelemetryEvent.js";
import type { TelemetryStorage, TelemetryQuery } from "./TelemetryStorage.js";
import { ReadTimings } from "../performance/ReadTimings.js";

export class JsonlTelemetryStorage implements TelemetryStorage {
    constructor(private readonly rootDirectory: string) {}

    async listEvents(query: TelemetryQuery, timings?: ReadTimings): Promise<NormalizedTelemetryEvent[]> {
        const discoverStart = performance.now();
        const files = await this.segmentFiles(this.rootDirectory);
        timings?.add("discover", performance.now() - discoverStart);
        if (timings) timings.fileCount += files.length;
        const events: NormalizedTelemetryEvent[] = [];
        for (const file of files) {
            const batch = await this.readBatch(file, timings);
            if (batch) {
                if (timings) timings.eventCount += batch.events.length;
                const append = () => events.push(...batch.events.filter((event) => matches(event, query)));
                if (timings) timings.measure("filter", append); else append();
            }
        }
        const sort = () => events.sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.spanId.localeCompare(right.spanId));
        return timings ? timings.measure("sort", sort) : sort();
    }

    private async segmentFiles(directory: string): Promise<string[]> {
        let entries;
        try {
            entries = await readdir(directory, { withFileTypes: true });
        } catch (error) {
            if (isNotFound(error)) return [];
            throw error;
        }
        const nested = await Promise.all(entries.map((entry) => {
            const path = join(directory, entry.name);
            return entry.isDirectory() ? this.segmentFiles(path) : entry.isFile() && entry.name.endsWith(".jsonl") ? [path] : [];
        }));
        return nested.flat();
    }

    private async readBatch(filePath: string, timings?: ReadTimings): Promise<NormalizedTelemetryBatch | undefined> {
        try {
            const readStart = performance.now();
            let content: string;
            try { content = await readFile(filePath, "utf8"); }
            finally { timings?.add("read", performance.now() - readStart); }
            const parse = () => {
                const value: unknown = JSON.parse(content.trim());
                return isNormalizedBatch(value) ? value : undefined;
            };
            return timings ? timings.measure("parse", parse) : parse();
        } catch {
            return undefined;
        }
    }
}

function matches(event: NormalizedTelemetryEvent, query: TelemetryQuery): boolean {
    return (!query.from || event.startedAt >= query.from)
        && (!query.to || event.startedAt <= query.to)
        && (!query.status || event.status === query.status)
        && (!query.type || event.type === query.type)
        && (!query.name || event.name === query.name)
        && (!query.runId || event.runId === query.runId);
}

function isNormalizedBatch(value: unknown): value is NormalizedTelemetryBatch {
    return typeof value === "object" && value !== null
        && "batchId" in value && typeof value.batchId === "string"
        && "receivedAt" in value && typeof value.receivedAt === "string"
        && "events" in value && Array.isArray(value.events);
}

function isNotFound(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
