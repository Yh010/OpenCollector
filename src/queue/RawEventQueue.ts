import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { rawEventQueueName } from "./queueName.js";

export interface RawEventBatchJob {
    batchId: string;
    filePath: string;
}

export class RawEventQueue {
    private readonly connection: Redis;
    private readonly queue: Queue<RawEventBatchJob>;

    constructor(redisUrl: string) {
        this.connection = new Redis(redisUrl, {
            maxRetriesPerRequest: null,
        });
        this.connection.on("error", () => undefined);
        this.queue = new Queue<RawEventBatchJob>(rawEventQueueName, {
            connection: this.connection,
            defaultJobOptions: {
                attempts: 3,
                backoff: {
                    type: "exponential",
                    delay: 1_000,
                },
            },
        });
    }

    async enqueueRawBatch(batch: RawEventBatchJob): Promise<void> {
        if (this.connection.status !== "ready") {
            throw new Error("Telemetry queue is unavailable");
        }

        await this.queue.add("process-raw-batch", batch, {
            jobId: batch.batchId,
        });
    }

    async close(): Promise<void> {
        await this.queue.close();
        await this.connection.quit();
    }
}
