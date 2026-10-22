import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OverviewStore } from "../overview/OverviewStore.js";
import type { NormalizedTelemetryEvent } from "./NormalizedTelemetryEvent.js";

export interface NormalizedEventSegmentWriterOptions {
    rootDirectory: string;
    overview?: OverviewStore;
}

export interface NormalizedTelemetryBatch {
    batchId: string;
    receivedAt: string;
    events: NormalizedTelemetryEvent[];
}

export class NormalizedEventSegmentWriter {
    private readonly overview: OverviewStore;
    constructor(private readonly options: NormalizedEventSegmentWriterOptions) {
        this.overview = options.overview ?? new OverviewStore(options.rootDirectory);
    }

    rebuildOverview() { return this.overview.rebuild(); }
    close(): void { this.overview.close(); }

    async write(batch: NormalizedTelemetryBatch): Promise<void> {
        const day = batch.receivedAt.slice(0, 10);
        const directory = join(this.options.rootDirectory, day);
        await mkdir(directory, { recursive: true });
        const target = join(directory, `${batch.batchId}.jsonl`);

        let persisted = batch;
        try {
            await writeFile(target, `${JSON.stringify(batch)}\n`, { encoding: "utf8", flag: "wx" });
        } catch (error) {
            if (!isAlreadyWrittenError(error)) throw error;
            persisted = JSON.parse(await readFile(target, "utf8")) as NormalizedTelemetryBatch;
        }
        // A failed projection commit fails the job; retry repairs the already-written segment.
        this.overview.applyBatch(target, persisted);
    }
}

function isAlreadyWrittenError(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
