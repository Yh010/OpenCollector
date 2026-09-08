import "dotenv/config";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { buildTraceTree, llmAnalytics, overview, runSummaries, spanBreakdown, timeSeries, workerBreakdown } from "./storage/TelemetryAnalytics.js";
import { JsonlTelemetryStorage } from "./storage/JsonlTelemetryStorage.js";
import { createTelemetryWorkbook } from "./storage/ExcelExport.js";
import type { TelemetryQuery } from "./storage/TelemetryStorage.js";
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
const storage = new JsonlTelemetryStorage(resolve(process.env.NORMALIZED_EVENTS_DIR ?? "data/normalized-events"));
const dashboardOrigin = process.env.DASHBOARD_ORIGIN ?? "http://localhost:5173";

const server = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", dashboardOrigin);
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (request.method === "OPTIONS") {
        response.writeHead(204).end();
        return;
    }
    const requestUrl = new URL(request.url ?? "/", "http://localhost");

    if (request.method === "GET") {
        try {
            if (await handleRead(requestUrl, response)) return;
        } catch (error) {
            console.error("[OpenCollector] Failed to read telemetry.", error);
            response.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Telemetry data could not be read" }));
            return;
        }
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

server.listen(port, "127.0.0.1", () => {
    console.log(`[OpenCollector] Listening on http://127.0.0.1:${port}`);
});

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

async function handleRead(url: URL, response: import("node:http").ServerResponse): Promise<boolean> {
    const query = parseQuery(url.searchParams);
    if (url.pathname === "/v1/telemetry/export.xlsx") {
        const filteredEvents = await storage.listEvents(withoutStatus(query));
        const runs = runSummaries(filteredEvents).filter((run) => !query.status || run.status === query.status);
        const matchingRunIds = new Set(runs.map((run) => run.runId));
        const exportEvents = matchingRunIds.size
            ? (await storage.listEvents({ ...(query.from ? { from: query.from } : {}), ...(query.to ? { to: query.to } : {}) })).filter((event) => matchingRunIds.has(event.runId))
            : await storage.listEvents(query);
        const workbook = await createTelemetryWorkbook(exportEvents, runs);
        response.writeHead(200, { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": "attachment; filename=opencollector-telemetry.xlsx" }).end(workbook);
        return true;
    }
    if (url.pathname === "/v1/telemetry/traces") {
        const runs = runSummaries(await storage.listEvents(withoutStatus(query))).filter((run) => !query.status || run.status === query.status);
        const page = parsePositiveInteger(url.searchParams.get("page") ?? undefined, 1);
        const limit = Math.min(parsePositiveInteger(url.searchParams.get("limit") ?? undefined, 50), 200);
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ items: runs.slice((page - 1) * limit, page * limit), page, limit, total: runs.length }));
        return true;
    }
    const runId = getRunId(url.pathname);
    if (runId) {
        const events = await storage.listEvents({ runId });
        response.writeHead(events.length ? 200 : 404, { "Content-Type": "application/json" }).end(JSON.stringify(events.length ? { runId, events, trace: buildTraceTree(events) } : { error: "Trace not found" }));
        return true;
    }
    const events = await storage.listEvents(query);
    const analytics = url.pathname === "/v1/telemetry/analytics/overview" ? overview(events)
        : url.pathname === "/v1/telemetry/analytics/timeseries" ? timeSeries(events)
        : url.pathname === "/v1/telemetry/analytics/spans" ? spanBreakdown(events)
        : url.pathname === "/v1/telemetry/analytics/workers" ? workerBreakdown(events)
        : url.pathname === "/v1/telemetry/analytics/llm" ? llmAnalytics(events)
        : undefined;
    if (analytics === undefined) return false;
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(analytics));
    return true;
}

function withoutStatus(query: TelemetryQuery): TelemetryQuery {
    const { status: _status, ...remaining } = query;
    return remaining;
}

function parseQuery(parameters: URLSearchParams): TelemetryQuery {
    const status = parameters.get("status");
    const type = parameters.get("type");
    return {
        ...(parameters.get("from") ? { from: parameters.get("from")! } : {}),
        ...(parameters.get("to") ? { to: parameters.get("to")! } : {}),
        ...(status === "ok" || status === "error" ? { status } : {}),
        ...(type ? { type: type as NonNullable<TelemetryQuery["type"]> } : {}),
        ...(parameters.get("name") ? { name: parameters.get("name")! } : {}),
        ...(parameters.get("runId") ? { runId: parameters.get("runId")! } : {}),
    };
}

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

function getRunId(pathname: string): string | undefined {
    const prefix = "/v1/telemetry/traces/";
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
