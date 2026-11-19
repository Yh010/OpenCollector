import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { setGlobalProxyFromEnv } from "node:http";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { Ownership, OwnershipError } from "./auth/Ownership.js";
import { OperatorAccess } from "./auth/OperatorAccess.js";
import { SupabaseTelemetryStorage } from "./storage/SupabaseTelemetryStorage.js";
import { parseTelemetryBatch } from "./telemetry/validateTelemetryBatch.js";
import { buildTraceTree, llmAnalytics, overview, runSummaries, spanBreakdown, timeSeries, workerBreakdown } from "./storage/TelemetryAnalytics.js";
import { createTelemetryWorkbook } from "./storage/ExcelExport.js";
import { InvalidTracePageError, parseTracePageOptions, decodeTraceCursor, encodeTraceCursor } from "./overview/TracePagination.js";
import type { TelemetryQuery } from "./storage/TelemetryStorage.js";

if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) {
    setDefaultCACertificates([...getCACertificates("default"), ...getCACertificates("system")]);
    setGlobalProxyFromEnv();
}
const url = process.env.SUPABASE_URL ?? "https://hzrnpjibpbaxjmlbfkeh.supabase.co";
const key = process.env.SUPABASE_PUBLISHABLE_KEY ?? "sb_publishable_Oz_JF1jdKuCkoox5LnffJw_qBTy6NC8";
const ownership = new Ownership(url, key);
const operator = new OperatorAccess(ownership, process.env.OPENCOLLECTOR_ADMIN_USER_IDS ?? "");
const storage = new SupabaseTelemetryStorage(url, key);
const origin = new URL(process.env.DASHBOARD_ORIGIN ?? "http://127.0.0.1:5175").origin;
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");

// Hosted mode deliberately has no Redis, worker, SQLite, or filesystem writes.
const server = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    response.setHeader("Cache-Control", "no-store");
    if (request.method === "OPTIONS") { response.writeHead(204).end(); return; }
    try {
        const address = new URL(request.url ?? "/", "http://localhost");
        const path = address.pathname;
        if (request.method === "GET" && path === "/health") { json(response, 200, { status: "ok" }); return; }
        if (request.method === "POST" && path === "/v1/telemetry/events") {
            // Reject unauthenticated uploads before buffering their bodies.
            await ownership.identity(request.headers.authorization);
            const batch = parseTelemetryBatch(await readBody(request));
            if (!batch || batch.events.length < 1 || batch.events.length > 1000
                || batch.events.some(event => !Number.isFinite(Date.parse(event.startedAt))
                    || !Number.isFinite(Date.parse(event.endedAt)) || Date.parse(event.endedAt) < Date.parse(event.startedAt))) {
                throw new OwnershipError(400, "Invalid telemetry batch");
            }
            const accepted = await ownership.accept(batch, request.headers.authorization);
            await storage.append(accepted, request.headers.authorization!);
            json(response, 202, { accepted: accepted.events.length }); return;
        }
        const identity = await operator.verify(request.headers.authorization);
        if (request.method === "GET" && path === "/v1/auth/me") { json(response, 200, identity); return; }
        if (request.method === "POST" && /^\/v1\/telemetry\/traces\/[^/]+\/analyze$/.test(path)) {
            json(response, 503, { error: "AI trace analysis needs a hosted model. Trace viewing and exports are available." }); return;
        }
        const analytics = new Map<string, (events: Awaited<ReturnType<typeof storage.listEvents>>) => unknown>([
            ["overview", overview], ["timeseries", timeSeries], ["spans", spanBreakdown], ["workers", workerBreakdown], ["llm", llmAnalytics],
        ]);
        const analysis = path.startsWith("/v1/telemetry/analytics/") ? analytics.get(path.slice("/v1/telemetry/analytics/".length)) : undefined;
        const detail = /^\/v1\/telemetry\/traces\/([^/]+)$/.exec(path);
        if (request.method !== "GET" || (!analysis && !detail && !["/v1/telemetry/traces", "/v1/telemetry/export.xlsx"].includes(path))) {
            json(response, 404, { error: "Not found" }); return;
        }
        const query = parseQuery(address.searchParams);
        if (detail) {
            const runId = decodeURIComponent(detail[1]!);
            if (!/^[0-9a-f-]{36}$/i.test(runId)) throw new OwnershipError(400, "Invalid run ID");
            const events = await storage.listEvents({ runId }, request.headers.authorization!);
            json(response, events.length ? 200 : 404, events.length ? { runId, events, trace: buildTraceTree(events) } : { error: "Trace not found" }); return;
        }
        if (analysis) { json(response, 200, analysis(await storage.listEvents(query, request.headers.authorization!))); return; }
        const { status, ...filters } = query;
        const events = await storage.listEvents(filters, request.headers.authorization!);
        const spanCounts = new Map<string, number>();
        for (const event of events) spanCounts.set(event.runId, (spanCounts.get(event.runId) ?? 0) + 1);
        const runs = runSummaries(events).map(run => ({ ...run, spanCount: spanCounts.get(run.runId) ?? 0 }))
            .filter(run => !status || run.status === status)
            .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.runId.localeCompare(a.runId));
        if (path === "/v1/telemetry/export.xlsx") {
            const ids = new Set(runs.map(run => run.runId));
            const all = await storage.listEvents({ ...(query.from ? { from: query.from } : {}), ...(query.to ? { to: query.to } : {}) }, request.headers.authorization!);
            const workbook = await createTelemetryWorkbook(all.filter(event => ids.has(event.runId)), runs);
            response.writeHead(200, { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": "attachment; filename=opencollector-telemetry.xlsx" }).end(workbook); return;
        }
        const page = parseTracePageOptions(address.searchParams);
        const cursor = decodeTraceCursor(page.cursor, query, page.limit);
        const remaining = cursor ? runs.filter(run => run.startedAt < cursor.startedAt || (run.startedAt === cursor.startedAt && run.runId < cursor.runId)) : runs.slice(((page.page ?? 1) - 1) * page.limit);
        const items = remaining.slice(0, page.limit);
        json(response, 200, { items, total: runs.length, limit: page.limit,
            nextCursor: remaining.length > page.limit ? encodeTraceCursor(items[items.length - 1]!, query, page.limit) : null });
    } catch (error) {
        const status = error instanceof OwnershipError ? error.status : error instanceof InvalidTracePageError || error instanceof SyntaxError || error instanceof URIError ? 400 : 503;
        json(response, status, { error: status === 503 ? "Telemetry service is unavailable. Retry shortly." : error instanceof Error ? error.message : "Invalid request" });
    }
});
server.listen(port, "0.0.0.0", () => console.log(`[OpenCollector] Hosted API listening on port ${port}`));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { server.close(); server.closeIdleConnections(); });

function json(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
}
async function readBody(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 1_000_000) throw new OwnershipError(413, "Telemetry batch exceeds 1 MB");
        chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function parseQuery(parameters: URLSearchParams): TelemetryQuery {
    const result: TelemetryQuery = {};
    for (const field of ["from", "to"] as const) {
        const value = parameters.get(field);
        if (value) {
            if (!Number.isFinite(Date.parse(value))) throw new OwnershipError(400, `Invalid ${field} date`);
            result[field] = new Date(value).toISOString();
        }
    }
    const status = parameters.get("status");
    if (status === "ok" || status === "error") result.status = status;
    const type = parameters.get("type");
    if (type) result.type = type as NonNullable<TelemetryQuery["type"]>;
    for (const field of ["name", "runId"] as const) { const value = parameters.get(field); if (value) result[field] = value; }
    return result;
}
