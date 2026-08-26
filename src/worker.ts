import "dotenv/config";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import { ClickHouseTelemetryWriter } from "./processed-events/ClickHouseTelemetryWriter.js";
import { normalizeRawTelemetryBatch } from "./processed-events/normalizeRawTelemetryBatch.js";
import type { RawEventBatchJob } from "./queue/RawEventQueue.js";
import { rawEventQueueName } from "./queue/queueName.js";
import { RawTelemetryBatchReader } from "./raw-events/RawTelemetryBatchReader.js";

const httpsProxy = process.env.OPENCOLLECTOR_HTTPS_PROXY?.trim();
if (httpsProxy) {
    setGlobalDispatcher(new ProxyAgent(httpsProxy));
}

const connection = new Redis(process.env.REDIS_URL ?? "redis://127.0.0.1:6379", {
    maxRetriesPerRequest: null,
});
const rawBatchReader = new RawTelemetryBatchReader();
const clickHouseWriter = new ClickHouseTelemetryWriter({
    url: requireEnvironmentVariable("CLICKHOUSE_URL"),
    username: requireEnvironmentVariable("CLICKHOUSE_USERNAME"),
    password: requireEnvironmentVariable("CLICKHOUSE_PASSWORD"),
    database: requireEnvironmentVariable("CLICKHOUSE_DATABASE"),
});

await clickHouseWriter.initialize();

connection.on("error", (error) => {
    console.error("[OpenCollector worker] Redis connection error", error);
});

const worker = new Worker<RawEventBatchJob>(
    rawEventQueueName,
    async (job) => {
        const rawBatch = await rawBatchReader.read(job.data.filePath, job.data.batchId);
        const normalizedEvents = normalizeRawTelemetryBatch(rawBatch);
        await clickHouseWriter.write(normalizedEvents);

        console.dir({
            event: "telemetry_batch_processed",
            batchId: rawBatch.batchId,
            eventCount: normalizedEvents.length,
        });

        return {
            batchId: rawBatch.batchId,
            eventCount: normalizedEvents.length,
            destination: "clickhouse",
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

function requireEnvironmentVariable(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) {
        throw new Error(`${name} is required`);
    }

    return value;
}
