import "dotenv/config";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { buildTraceTree, ClickHouseTelemetryReader } from "./processed-events/ClickHouseTelemetryReader.js";
import { RawEventSegmentWriter } from "./raw-events/RawEventSegmentWriter.js";
import { RawEventQueue } from "./queue/RawEventQueue.js";
import { parseTelemetryBatch } from "./telemetry/validateTelemetryBatch.js";

const port = parsePort(process.env.PORT);
const maxRequestBytes = 1_000_000;
const rawEventWriter = new RawEventSegmentWriter({
    rootDirectory: resolve(process.env.RAW_EVENTS_DIR ?? "data/raw-events"),
    maxSegmentBytes: parsePositiveInteger(process.env.RAW_EVENT_SEGMENT_MAX_BYTES, 128 * 1024 * 1024),
    segmentIntervalMs: parsePositiveInteger(process.env.RAW_EVENT_SEGMENT_INTERVAL_MS, 5 * 60 * 1000),
});
const rawEventQueue = new RawEventQueue(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
const clickHouseTelemetryReader = new ClickHouseTelemetryReader({
    url: requireEnvironmentVariable("CLICKHOUSE_URL"),
    username: requireEnvironmentVariable("CLICKHOUSE_USERNAME"),
    password: requireEnvironmentVariable("CLICKHOUSE_PASSWORD"),
    database: requireEnvironmentVariable("CLICKHOUSE_DATABASE"),
});

const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    const runId = getRunId(requestUrl.pathname);

    if (request.method === "GET" && runId) {
        try {
            const events = await clickHouseTelemetryReader.getRunEvents(runId);
            response.writeHead(200, { "Content-Type": "application/json" }).end(
                JSON.stringify({ runId, events, trace: buildTraceTree(events) }),
            );
        } catch (error) {
            console.error("[OpenCollector] Failed to read telemetry run.", error);
            response.writeHead(502, { "Content-Type": "application/json" }).end(
                JSON.stringify({ error: "Telemetry run could not be read" }),
            );
        }
        return;
    }

    if (request.method !== "POST" || requestUrl.pathname !== "/v1/telemetry/events") {
        response.writeHead(404).end();
        return;
    }

    let batch;
    try {
        const body = await readJsonBody(request, maxRequestBytes);
        batch = parseTelemetryBatch(body);

        if (!batch) {
            response.writeHead(400, { "Content-Type": "application/json" }).end(
                JSON.stringify({ error: "Invalid telemetry batch" }),
            );
            return;
        }
    } catch (error) {
        const statusCode = error instanceof RequestTooLargeError ? 413 : 400;
        response.writeHead(statusCode, { "Content-Type": "application/json" }).end(
            JSON.stringify({ error: error instanceof Error ? error.message : "Invalid request" }),
        );
        return;
    }

    try {
        const storedBatch = await rawEventWriter.write(batch.events);
        await rawEventQueue.enqueueRawBatch(storedBatch);

        console.dir({
            event: "telemetry_batch_accepted",
            eventCount: batch.events.length,
            batchId: storedBatch.batchId,
            filePath: storedBatch.filePath,
        });

        response.writeHead(202, { "Content-Type": "application/json" }).end(
            JSON.stringify({ batchId: storedBatch.batchId }),
        );
    } catch {
        response.writeHead(503, { "Content-Type": "application/json" }).end(
            JSON.stringify({ error: "Telemetry batch could not be queued" }),
        );
    }
});

server.listen(port, () => {
    console.log(`[OpenCollector] Listening on http://localhost:${port}`);
});

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

async function shutdown(): Promise<void> {
    server.close();
    await rawEventQueue.close();
}

function parsePort(value: string | undefined): number {
    const port = Number(value ?? 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("PORT must be an integer between 1 and 65535");
    }
    return port;
}

function parsePositiveInteger(value: string | undefined, defaultValue: number): number {
    const parsedValue = Number(value ?? defaultValue);
    if (!Number.isInteger(parsedValue) || parsedValue < 1) {
        throw new Error("Expected a positive integer configuration value");
    }

    return parsedValue;
}

function requireEnvironmentVariable(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) {
        throw new Error(`${name} is required`);
    }

    return value;
}

function getRunId(pathname: string): string | undefined {
    const prefix = "/v1/telemetry/runs/";
    if (!pathname.startsWith(prefix)) {
        return undefined;
    }

    const runId = decodeURIComponent(pathname.slice(prefix.length));
    return runId && !runId.includes("/") ? runId : undefined;
}

async function readJsonBody(request: import("node:http").IncomingMessage, maxBytes: number): Promise<unknown> {
    let body = "";

    for await (const chunk of request) {
        body += chunk;
        if (Buffer.byteLength(body) > maxBytes) {
            throw new RequestTooLargeError(`Request body exceeds ${maxBytes} bytes`);
        }
    }

    return JSON.parse(body);
}

class RequestTooLargeError extends Error {}
