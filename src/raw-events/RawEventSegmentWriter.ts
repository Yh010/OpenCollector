import { appendFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { TelemetryEvent } from "../telemetry/TelemetryEvent.js";
import type { RawTelemetryBatch } from "./RawTelemetryBatch.js";

export interface RawEventSegmentWriterOptions {
    rootDirectory: string;
    maxSegmentBytes: number;
    segmentIntervalMs: number;
}

export interface StoredRawBatch {
    batchId: string;
    filePath: string;
}

interface ActiveSegment {
    filePath: string;
    createdAtMs: number;
    bytesWritten: number;
}

export class RawEventSegmentWriter {
    private activeSegment: ActiveSegment | undefined;
    private writeTail = Promise.resolve();

    constructor(private readonly options: RawEventSegmentWriterOptions) {}

    write(events: TelemetryEvent[]): Promise<StoredRawBatch> {
        const batchId = randomUUID();
        const rawBatch: RawTelemetryBatch = {
            batchId,
            receivedAt: new Date().toISOString(),
            events,
        };
        const line = `${JSON.stringify(rawBatch)}\n`;
        const lineBytes = Buffer.byteLength(line);

        const result = this.writeTail.then(async () => {
            const segment = await this.getSegment(lineBytes);
            await appendFile(segment.filePath, line, "utf8");
            segment.bytesWritten += lineBytes;

            return { batchId, filePath: segment.filePath };
        });

        this.writeTail = result.then(
            () => undefined,
            () => undefined,
        );

        return result;
    }

    private async getSegment(nextLineBytes: number): Promise<ActiveSegment> {
        const now = Date.now();
        const current = this.activeSegment;

        if (
            current !== undefined &&
            now - current.createdAtMs < this.options.segmentIntervalMs &&
            current.bytesWritten + nextLineBytes <= this.options.maxSegmentBytes
        ) {
            return current;
        }

        const dateDirectory = new Date(now).toISOString().slice(0, 10);
        const directory = join(this.options.rootDirectory, dateDirectory);
        await mkdir(directory, { recursive: true });

        const filePath = join(directory, `${new Date(now).toISOString().replaceAll(":", "-")}-${randomUUID()}.jsonl`);
        const existingBytes = await this.fileSize(filePath);
        const segment = {
            filePath,
            createdAtMs: now,
            bytesWritten: existingBytes,
        };

        this.activeSegment = segment;
        return segment;
    }

    private async fileSize(filePath: string): Promise<number> {
        try {
            return (await stat(filePath)).size;
        } catch (error) {
            if (isFileNotFoundError(error)) {
                return 0;
            }

            throw error;
        }
    }
}

function isFileNotFoundError(error: unknown): error is NodeJS.ErrnoException {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
