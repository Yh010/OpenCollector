import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { NormalizedTelemetryEvent } from "./NormalizedTelemetryEvent.js";

export interface NormalizedEventSegmentWriterOptions {
    rootDirectory: string;
}

export interface NormalizedTelemetryBatch {
    batchId: string;
    receivedAt: string;
    events: NormalizedTelemetryEvent[];
}

export class NormalizedEventSegmentWriter {
    constructor(private readonly options: NormalizedEventSegmentWriterOptions) {}

    async write(batch: NormalizedTelemetryBatch): Promise<void> {
        const day = batch.receivedAt.slice(0, 10);
        const directory = join(this.options.rootDirectory, day);
        await mkdir(directory, { recursive: true });
        const target = join(directory, `${batch.batchId}.jsonl`);

        try {
            await writeFile(target, `${JSON.stringify(batch)}\n`, { encoding: "utf8", flag: "wx" });
        } catch (error) {
            if (!isAlreadyWrittenError(error)) throw error;
        }
    }
}

function isAlreadyWrittenError(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
