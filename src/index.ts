import "dotenv/config";
import { TraceAnalyzer, TraceAnalysisError } from "./analysis/TraceAnalysis.js";
import { InvalidTracePageError, parseTracePageOptions } from "./overview/TracePagination.js";
import { OverviewStore } from "./overview/OverviewStore.js";
import { ReadTimings } from "./performance/ReadTimings.js";
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
const normalizedRoot = resolve(process.env.NORMALIZED_EVENTS_DIR ?? "data/normalized-events");
const storage = new JsonlTelemetryStorage(normalizedRoot);
const overviewStore = new OverviewStore(normalizedRoot);
const traceAnalyzer = new TraceAnalyzer();
const dashboardOrigin = process.env.DASHBOARD_ORIGIN ?? "http://localhost:5173";

const server = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", dashboardOrigin);
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    response.setHeader("Access-Control-Expose-Headers", "Server-Timing, X-Overview-Source, X-Overview-Updated-At, X-Timeseries-Source, X-Timeseries-Updated-At, X-Spans-Source, X-Spans-Updated-At, X-Llm-Source, X-Llm-Updated-At, X-Traces-Source, X-Traces-Updated-At, X-Trace-Source, X-Trace-Updated-At");
    response.setHeader("Timing-Allow-Origin", dashboardOrigin);
    if (request.method === "OPTIONS") {
        response.writeHead(204).end();
        return;
    }
    const requestUrl = new URL(request.url ?? "/", "http://localhost");

    if (request.method === "POST" && requestUrl.pathname.startsWith("/v1/telemetry/traces/") && requestUrl.pathname.endsWith("/analyze")) {
        response.setHeader("Cache-Control", "no-store");
        if (request.headers.origin && request.headers.origin !== dashboardOrigin) {
            writeJson(response, 403, { error: "Analysis requests must come from the dashboard" }, new ReadTimings());
            return;
        }
        const controller = new AbortController();
        const cancel = () => { if (!response.writableEnded) controller.abort(); };
        response.once("close", cancel);
        const timings = new ReadTimings();
        try {
            const runId = getRunId(requestUrl.pathname.slice(0, -"/analyze".length));
            if (!runId) { writeJson(response, 400, { error: "Invalid run ID" }, timings); return; }
            const index = overviewStore.lookupRunSegments(runId);
            if (!index) { writeJson(response, 503, { error: "Trace index is initializing. Try again shortly." }, timings); return; }
            const events = await storage.listRunEvents(runId, index.paths, timings);
            if (!events.length) { writeJson(response, 404, { error: "Trace not found" }, timings); return; }
            const analysis = await traceAnalyzer.analyze(events, controller.signal);
            if (!controller.signal.aborted) writeJson(response, 200, analysis, timings);
        } catch (error) {
            if (!controller.signal.aborted) writeJson(response, error instanceof TraceAnalysisError ? error.status : 500,
                { error: error instanceof TraceAnalysisError ? error.message : "Trace analysis could not be completed. Try again." }, timings);
        } finally { response.off("close", cancel); }
        return;
    }

    if (request.method === "GET") {
        const timings = new ReadTimings();
        try {
            if (await handleRead(requestUrl, response, timings)) return;
        } catch (error) {
            if (error instanceof InvalidTracePageError) {
                writeJson(response, 400, { error: error.message }, timings);
                return;
            }
            console.error("[OpenCollector] Failed to read telemetry.", error);
            writeJson(response, 500, { error: "Telemetry data could not be read" }, timings);
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

async function handleRead(url: URL, response: import("node:http").ServerResponse, timings: ReadTimings): Promise<boolean> {
    // Comparison mode is available only on local development servers unless explicitly disabled.
    const baseline = url.searchParams.get("optimizations") === "off";
    if (baseline && (process.env.NODE_ENV === "production" || process.env.PERFORMANCE_DEMO_ENABLED === "false")) {
        writeJson(response, 400, { error: "Optimization comparison is disabled on this server" }, timings);
        return true;
    }
    const precomputedOverviewEnabled = !baseline && process.env.OVERVIEW_PRECOMPUTED !== "false";
    const precomputedTimeSeriesEnabled = !baseline && process.env.TIMESERIES_PRECOMPUTED !== "false";
    const precomputedSpansEnabled = !baseline && process.env.SPANS_PRECOMPUTED !== "false";
    const precomputedLlmEnabled = !baseline && process.env.LLM_PRECOMPUTED !== "false";
    const precomputedTracesEnabled = !baseline && process.env.TRACES_PRECOMPUTED !== "false";
    const indexedTraceDetailEnabled = !baseline && process.env.TRACE_DETAIL_INDEXED !== "false";
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
        const page = parseTracePageOptions(url.searchParams);
        const snapshot = precomputedTracesEnabled ? timings.measure("summary", () => overviewStore.readTracePage(query, page)) : undefined;
        if (snapshot) {
            response.setHeader("X-Traces-Source", "precomputed");
            response.setHeader("X-Traces-Updated-At", snapshot.updatedAt);
            writeJson(response, 200, snapshot.result, timings);
            return true;
        }
        // Normal pagination requires the index; never scan JSONL while it initializes.
        if (precomputedTracesEnabled) {
            response.setHeader("Retry-After", "2");
            writeJson(response, 503, { error: "Trace index is initializing. Retry after the worker rebuild completes." }, timings);
            return true;
        }
        // Explicit experimental baseline keeps the former full-list behavior.
        response.setHeader("X-Traces-Source", "live-baseline");
        const events = await storage.listEvents(withoutStatus(query), timings);
        const runs = timings.measure("compute", () => runSummaries(events).filter((run) => !query.status || run.status === query.status));
        writeJson(response, 200, { items: runs, total: runs.length }, timings);
        return true;
    }
    const runId = getRunId(url.pathname);
    if (runId) {
        const index = indexedTraceDetailEnabled ? timings.measure("index", () => overviewStore.lookupRunSegments(runId)) : undefined;
        if (indexedTraceDetailEnabled && !index) {
            response.setHeader("Retry-After", "2");
            writeJson(response, 503, { error: "Trace index is initializing. Retry after the worker rebuild completes." }, timings);
            return true;
        }
        response.setHeader("X-Trace-Source", indexedTraceDetailEnabled ? "indexed-jsonl" : "live-baseline");
        if (index) response.setHeader("X-Trace-Updated-At", index.updatedAt);
        const events = index ? await storage.listRunEvents(runId, index.paths, timings) : await storage.listEvents({ runId }, timings);
        const result = timings.measure("compute", () => events.length ? { runId, events, trace: buildTraceTree(events) } : { error: "Trace not found" });
        writeJson(response, events.length ? 200 : 404, result, timings);
        return true;
    }
    if (url.pathname === "/v1/telemetry/analytics/overview") {
        const snapshot = precomputedOverviewEnabled ? timings.measure("summary", () => overviewStore.read(query)) : undefined;
        if (snapshot) {
            response.setHeader("X-Overview-Source", "precomputed");
            response.setHeader("X-Overview-Updated-At", snapshot.updatedAt);
            writeJson(response, 200, snapshot.result, timings);
            return true;
        }
        // Preserve correct responses before the initial background rebuild completes.
        response.setHeader("X-Overview-Source", precomputedOverviewEnabled ? "live-fallback" : "live-baseline");
    }
    if (url.pathname === "/v1/telemetry/analytics/timeseries") {
        const snapshot = precomputedTimeSeriesEnabled ? timings.measure("summary", () => overviewStore.readTimeSeries(query)) : undefined;
        if (snapshot) {
            response.setHeader("X-Timeseries-Source", "precomputed");
            response.setHeader("X-Timeseries-Updated-At", snapshot.updatedAt);
            writeJson(response, 200, snapshot.result, timings);
            return true;
        }
        response.setHeader("X-Timeseries-Source", precomputedTimeSeriesEnabled ? "live-fallback" : "live-baseline");
    }
    if (url.pathname === "/v1/telemetry/analytics/spans") {
        const snapshot = precomputedSpansEnabled ? timings.measure("summary", () => overviewStore.readSpans(query)) : undefined;
        if (snapshot) {
            response.setHeader("X-Spans-Source", "precomputed");
            response.setHeader("X-Spans-Updated-At", snapshot.updatedAt);
            writeJson(response, 200, snapshot.result, timings);
            return true;
        }
        response.setHeader("X-Spans-Source", precomputedSpansEnabled ? "live-fallback" : "live-baseline");
    }
    if (url.pathname === "/v1/telemetry/analytics/llm") {
        const snapshot = precomputedLlmEnabled ? timings.measure("summary", () => overviewStore.readLlm(query)) : undefined;
        if (snapshot) {
            response.setHeader("X-Llm-Source", "precomputed");
            response.setHeader("X-Llm-Updated-At", snapshot.updatedAt);
            writeJson(response, 200, snapshot.result, timings);
            return true;
        }
        response.setHeader("X-Llm-Source", precomputedLlmEnabled ? "live-fallback" : "live-baseline");
    }
    const events = await storage.listEvents(query, timings);
    const analytics = timings.measure("compute", () => url.pathname === "/v1/telemetry/analytics/overview" ? overview(events)
        : url.pathname === "/v1/telemetry/analytics/timeseries" ? timeSeries(events)
        : url.pathname === "/v1/telemetry/analytics/spans" ? spanBreakdown(events)
        : url.pathname === "/v1/telemetry/analytics/workers" ? workerBreakdown(events)
        : url.pathname === "/v1/telemetry/analytics/llm" ? llmAnalytics(events)
        : undefined);
    if (analytics === undefined) return false;
    writeJson(response, 200, analytics, timings);
    return true;
}

function writeJson(response: import("node:http").ServerResponse, status: number, value: unknown, timings: ReadTimings): void {
    const body = timings.measure("serialize", () => JSON.stringify(value));
    response.writeHead(status, { "Content-Type": "application/json", "Server-Timing": timings.header() }).end(body);
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
    server.close(() => overviewStore.close());
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
