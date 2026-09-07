import "dotenv/config";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { resolve } from "node:path";
import { NormalizedEventSegmentWriter } from "./processed-events/NormalizedEventSegmentWriter.js";
import { normalizeRawTelemetryBatch } from "./processed-events/normalizeRawTelemetryBatch.js";
import type { RawEventBatchJob } from "./queue/RawEventQueue.js";
import { rawEventQueueName } from "./queue/queueName.js";
import { RawTelemetryBatchReader } from "./raw-events/RawTelemetryBatchReader.js";

const connection = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379", {
    maxRetriesPerRequest: null,
});
const rawBatchReader = new RawTelemetryBatchReader();
const normalizedEventWriter = new NormalizedEventSegmentWriter({
    rootDirectory: resolve(process.env.NORMALIZED_EVENTS_DIR ?? "data/normalized-events"),
});

connection.on("error", (error) => {
    console.error("[OpenCollector worker] Redis connection error", error);
});

const worker = new Worker<RawEventBatchJob>(
    rawEventQueueName,
    async (job) => {
        const rawBatch = await rawBatchReader.read(job.data.filePath, job.data.batchId);
        const normalizedEvents = normalizeRawTelemetryBatch(rawBatch);
        await normalizedEventWriter.write({
            batchId: rawBatch.batchId,
            receivedAt: rawBatch.receivedAt,
            events: normalizedEvents,
        });

        console.dir({
            event: "telemetry_batch_processed",
            batchId: rawBatch.batchId,
            eventCount: normalizedEvents.length,
        });

        return {
            batchId: rawBatch.batchId,
            eventCount: normalizedEvents.length,
            destination: "normalized-jsonl",
        };
    },
    { connection },
);

await worker.waitUntilReady();
console.log(`[OpenCollector worker] Listening for jobs on ${rawEventQueueName}`);

worker.on("failed", (job, error) => {
    console.error("[OpenCollector worker] Failed to process telemetry batch", {
        jobId: job?.id,
        error: error.message,
    });
});

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

async function shutdown(): Promise<void> {
    await worker.close();
    await connection.quit();
}
