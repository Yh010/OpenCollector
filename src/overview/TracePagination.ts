import { createHash } from "node:crypto";
import type { TelemetryQuery } from "../storage/TelemetryStorage.js";

export interface TracePageOptions { limit: number; cursor?: string; page?: number }
export class InvalidTracePageError extends Error {}
type Cursor = { startedAt: string; runId: string; filterKey: string };
const filterKey = (query: TelemetryQuery, limit: number) => createHash("sha256")
    .update(JSON.stringify([limit, Object.entries(query).filter(([, value]) => value).sort(([a], [b]) => a.localeCompare(b))])).digest("hex");

export function parseTracePageOptions(parameters: URLSearchParams): TracePageOptions {
    const value = parameters.get("limit") ?? "50";
    if (!/^[1-9]\d*$/.test(value) || Number(value) > 200) throw new InvalidTracePageError("limit must be an integer between 1 and 200");
    const cursor = parameters.get("cursor");
    if (cursor !== null && (!cursor || cursor.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(cursor))) throw new InvalidTracePageError("Invalid trace cursor");
    const page = parameters.get("page");
    if (page !== null && (!/^[1-9]\d*$/.test(page) || !Number.isSafeInteger(Number(page)))) throw new InvalidTracePageError("page must be a positive integer");
    if (page !== null && cursor !== null) throw new InvalidTracePageError("Use either page or cursor, not both");
    return { limit: Number(value), ...(cursor !== null ? { cursor } : {}), ...(page !== null ? { page: Number(page) } : {}) };
}

export function decodeTraceCursor(cursor: string | undefined, query: TelemetryQuery, limit: number): Cursor | undefined {
    if (cursor === undefined) return undefined;
    try {
        if (!cursor || cursor.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
        const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Cursor;
        if (typeof value.startedAt !== "string" || typeof value.runId !== "string" || !value.runId
            || value.filterKey !== filterKey(query, limit)) throw new Error();
        return value;
    } catch { throw new InvalidTracePageError("Invalid trace cursor or cursor does not match these filters and page size"); }
}

export function encodeTraceCursor(item: { startedAt: string; runId: string }, query: TelemetryQuery, limit: number): string {
    return Buffer.from(JSON.stringify({ startedAt: item.startedAt, runId: item.runId, filterKey: filterKey(query, limit) })).toString("base64url");
}
