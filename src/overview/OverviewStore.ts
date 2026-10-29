import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { NormalizedTelemetryBatch } from "../processed-events/NormalizedEventSegmentWriter.js";
import type { NormalizedTelemetryEvent } from "../processed-events/NormalizedTelemetryEvent.js";
import { llmAnalytics, runSummaries, spanBreakdown } from "../storage/TelemetryAnalytics.js";
import type { overview, timeSeries } from "../storage/TelemetryAnalytics.js";
import { decodeTraceCursor, encodeTraceCursor, InvalidTracePageError } from "./TracePagination.js";
import type { TracePageOptions } from "./TracePagination.js";
import type { TelemetryQuery } from "../storage/TelemetryStorage.js";

type Overview = ReturnType<typeof overview>;
type TimeSeries = ReturnType<typeof timeSeries>;
type Spans = ReturnType<typeof spanBreakdown>;
type Llm = ReturnType<typeof llmAnalytics>;
type Traces = { items: ReturnType<typeof runSummaries>; total: number };
export type TracePage = Traces & { nextCursor: string | null; cursor: string | null; limit: number };
type ProjectedEvent = Pick<NormalizedTelemetryEvent, "runId" | "type" | "name" | "status" | "startedAt" | "endedAt" | "spanId" | "durationMs" | "llm">;
type Segment = { path: string; digest: string; events: ProjectedEvent[] };
type State = { ready: number; revision: number; updated_at: string; payload: string };
export type OverviewSnapshot = { result: Overview; updatedAt: string };

/** Disposable projection; normalized JSONL remains the source of truth. */
export class OverviewStore {
    private readonly db: DatabaseSync;
    private readonly insertEvent: ReturnType<DatabaseSync["prepare"]>;
    private readonly insertSpan: ReturnType<DatabaseSync["prepare"]>;
    private readonly insertLlm: ReturnType<DatabaseSync["prepare"]>;
    private readonly root: string;

    constructor(rootDirectory: string) {
        this.root = resolve(rootDirectory);
        mkdirSync(this.root, { recursive: true });
        this.db = new DatabaseSync(join(this.root, ".overview.sqlite"), { timeout: 5_000 });
        this.db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;");
        const version = this.db.prepare("PRAGMA user_version").get()!.user_version;
        if (version !== 0 && version !== 1) {
            this.db.close();
            throw new Error("Unsupported overview projection version. Rebuild with the matching collector version.");
        }
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS segments (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, digest TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS events (
                segment_id INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
                ordinal INTEGER NOT NULL, run_id TEXT NOT NULL, type TEXT NOT NULL, name TEXT NOT NULL,
                status TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT NOT NULL,
                PRIMARY KEY (segment_id, ordinal)
            );
            CREATE INDEX IF NOT EXISTS event_run ON events(run_id, started_at);
            CREATE INDEX IF NOT EXISTS event_kind ON events(type, name, started_at);
            CREATE INDEX IF NOT EXISTS event_date ON events(started_at);
            CREATE TABLE IF NOT EXISTS state (
                id INTEGER PRIMARY KEY CHECK(id=1), ready INTEGER NOT NULL, revision INTEGER NOT NULL,
                updated_at TEXT NOT NULL, payload TEXT NOT NULL
            );
            INSERT OR IGNORE INTO state VALUES (1, 0, 0, '', '{}');
            CREATE TABLE IF NOT EXISTS timeseries_state (
                id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS span_events (
                segment_id INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
                ordinal INTEGER NOT NULL, span_id TEXT NOT NULL, duration_ms REAL NOT NULL,
                PRIMARY KEY (segment_id, ordinal)
            );
            CREATE TABLE IF NOT EXISTS spans_state (
                id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS llm_events (
                segment_id INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
                ordinal INTEGER NOT NULL, provider TEXT, model TEXT,
                input_tokens REAL NOT NULL, output_tokens REAL NOT NULL,
                PRIMARY KEY (segment_id, ordinal)
            );
            CREATE TABLE IF NOT EXISTS llm_state (
                id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS traces_state (
                id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS trace_runs (
                run_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, ended_at TEXT NOT NULL,
                status TEXT NOT NULL, span_count INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS trace_runs_order ON trace_runs(started_at DESC, run_id DESC);
            CREATE INDEX IF NOT EXISTS trace_runs_status_order ON trace_runs(status, started_at DESC, run_id DESC);
            CREATE TABLE IF NOT EXISTS trace_pages_state (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
            PRAGMA user_version=1;
        `);
        this.insertEvent = this.db.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
        this.insertSpan = this.db.prepare("INSERT INTO span_events VALUES (?, ?, ?, ?)");
        this.insertLlm = this.db.prepare("INSERT INTO llm_events VALUES (?, ?, ?, ?, ?, ?)");
    }

    close(): void { this.db.close(); }

    read(query: TelemetryQuery): OverviewSnapshot | undefined {
        return this.transaction(() => {
            const state = this.state();
            if (!state.ready) return undefined;
            const unfiltered = !Object.values(query).some(Boolean);
            return { result: unfiltered ? JSON.parse(state.payload) as Overview : this.calculate(query), updatedAt: state.updated_at };
        }, "DEFERRED");
    }

    readTimeSeries(query: TelemetryQuery): { result: TimeSeries; updatedAt: string } | undefined {
        return this.transaction(() => {
            const state = this.state();
            const saved = this.db.prepare("SELECT revision, payload FROM timeseries_state WHERE id=1").get();
            // An older projection has no daily summary until the next managed rebuild/update.
            if (!state.ready || saved?.revision !== state.revision) return undefined;
            return {
                result: !Object.values(query).some(Boolean) ? JSON.parse(saved.payload as string) as TimeSeries : this.calculateTimeSeries(query),
                updatedAt: state.updated_at,
            };
        }, "DEFERRED");
    }

    readSpans(query: TelemetryQuery): { result: Spans; updatedAt: string } | undefined {
        return this.transaction(() => {
            const state = this.state();
            const saved = this.db.prepare("SELECT revision, payload FROM spans_state WHERE id=1").get();
            if (!state.ready || saved?.revision !== state.revision) return undefined;
            return {
                result: !Object.values(query).some(Boolean) ? JSON.parse(saved.payload as string) as Spans : this.calculateSpans(query),
                updatedAt: state.updated_at,
            };
        }, "DEFERRED");
    }

    readLlm(query: TelemetryQuery): { result: Llm; updatedAt: string } | undefined {
        return this.transaction(() => {
            const state = this.state();
            const saved = this.db.prepare("SELECT revision, payload FROM llm_state WHERE id=1").get();
            if (!state.ready || saved?.revision !== state.revision) return undefined;
            return {
                result: !Object.values(query).some(Boolean) ? JSON.parse(saved.payload as string) as Llm : this.calculateLlm(query),
                updatedAt: state.updated_at,
            };
        }, "DEFERRED");
    }

    lookupRunSegments(runId: string): { paths: string[]; updatedAt: string } | undefined {
        return this.transaction(() => {
            const state = this.state();
            if (!state.ready) return undefined;
            const rows = this.db.prepare(`SELECT DISTINCT segments.path FROM events
                JOIN segments ON segments.id=events.segment_id WHERE events.run_id=? ORDER BY segments.path`).all(runId);
            return { paths: rows.map(row => String(row.path)), updatedAt: state.updated_at };
        }, "DEFERRED");
    }

    readTraces(query: TelemetryQuery): { result: Traces; updatedAt: string } | undefined {
        return this.transaction(() => {
            const state = this.state();
            const saved = this.db.prepare("SELECT revision, payload FROM traces_state WHERE id=1").get();
            if (!state.ready || saved?.revision !== state.revision) return undefined;
            // Status applies to combined root-run summaries, not individual events.
            const { status, ...filters } = query;
            const base = !Object.values(filters).some(Boolean) ? JSON.parse(saved.payload as string) as Traces : this.calculateTraces(filters);
            const items = status ? base.items.filter(run => run.status === status) : base.items;
            return { result: { items, total: items.length }, updatedAt: state.updated_at };
        }, "DEFERRED");
    }

    readTracePage(query: TelemetryQuery, options: TracePageOptions): { result: TracePage; updatedAt: string } | undefined {
        if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 200) throw new InvalidTracePageError("limit must be an integer between 1 and 200");
        if (options.page !== undefined && (!Number.isSafeInteger(options.page) || options.page < 1)) throw new InvalidTracePageError("page must be a positive integer");
        if (options.page !== undefined && options.cursor !== undefined) throw new InvalidTracePageError("Use either page or cursor, not both");
        let cursor = decodeTraceCursor(options.cursor, query, options.limit);
        let pageCursor = options.cursor ?? null;
        return this.transaction(() => {
            const state = this.state();
            if (!state.ready || this.db.prepare("SELECT revision FROM trace_pages_state WHERE id=1").get()?.revision !== state.revision) return undefined;
            const { status, ...filters } = query;
            const indexed = !filters.from && !filters.to && !filters.type && !filters.name;
            const { where, values } = this.predicate(indexed ? (filters.runId ? { runId: filters.runId } : {}) : filters);
            const source = indexed ? "trace_runs" : `(
                SELECT run_id, MIN(started_at) AS started_at, MAX(ended_at) AS ended_at,
                    CASE MAX(CASE WHEN status='error' THEN 1 ELSE 0 END) WHEN 1 THEN 'error' ELSE 'ok' END AS status,
                    COUNT(*) AS span_count
                FROM events WHERE ${where} AND type='run' AND name='openKode-run' GROUP BY run_id
            )`;
            const clauses = indexed ? [where] : ["1=1"];
            const params: Array<string | number> = [...values];
            if (status) { clauses.push("status=?"); params.push(status); }
            const total = Number(this.db.prepare(`SELECT COUNT(*) AS count FROM ${source} WHERE ${clauses.join(" AND ")}`).get(...params)!.count);
            if (options.page !== undefined && options.page > Math.max(1, Math.ceil(total / options.limit)))
                throw new InvalidTracePageError(`page must be between 1 and ${Math.max(1, Math.ceil(total / options.limit))}`);
            if (options.page !== undefined && options.page > 1) {
                // Random access needs an index walk to locate the boundary. Normal navigation remains keyset-based.
                const anchor = this.db.prepare(`SELECT started_at AS startedAt, run_id AS runId FROM ${source}
                    WHERE ${clauses.join(" AND ")} ORDER BY started_at DESC, run_id DESC LIMIT 1 OFFSET ?`)
                    .get(...params, (options.page - 1) * options.limit - 1) as unknown as { startedAt: string; runId: string };
                pageCursor = encodeTraceCursor(anchor, query, options.limit);
                cursor = decodeTraceCursor(pageCursor, query, options.limit);
            }
            if (cursor) { clauses.push("(started_at, run_id) < (?, ?)"); params.push(cursor.startedAt, cursor.runId); }
            type Row = { runId: string; startedAt: string; endedAt: string; status: "ok" | "error"; spanCount: number };
            // Fetch one extra row to detect the next page; never load the full list into JS.
            const rows = this.db.prepare(`SELECT run_id AS runId, started_at AS startedAt, ended_at AS endedAt,
                status, span_count AS spanCount FROM ${source} WHERE ${clauses.join(" AND ")}
                ORDER BY started_at DESC, run_id DESC LIMIT ?`).all(...params, options.limit + 1) as unknown as Row[];
            const hasMore = rows.length > options.limit;
            if (hasMore) rows.pop();
            const items = rows.map(row => ({ runId: row.runId, startedAt: row.startedAt, endedAt: row.endedAt,
                durationMs: Date.parse(row.endedAt) - Date.parse(row.startedAt), status: row.status, spanCount: row.spanCount }));
            return { result: { items, total, limit: options.limit, cursor: pageCursor,
                nextCursor: hasMore ? encodeTraceCursor(items[items.length - 1]!, query, options.limit) : null }, updatedAt: state.updated_at };
        }, "DEFERRED");
    }

    /** Retry-safe: replace the contribution from a segment, never increment it twice. */
    applyBatch(filePath: string, batch: NormalizedTelemetryBatch): void {
        const segment = this.project(filePath, batch);
        this.transaction(() => {
            const existing = this.db.prepare("SELECT digest FROM segments WHERE path=?").get(segment.path);
            if (existing?.digest === segment.digest) return;
            this.db.prepare("DELETE FROM segments WHERE path=?").run(segment.path);
            this.insertSegment(segment);
            this.publish(Boolean(this.state().ready));
        });
    }

    /** Publish the complete replacement atomically; readers keep the previous snapshot during scanning. */
    async rebuild(): Promise<OverviewSnapshot> {
        for (let attempt = 0; attempt < 3; attempt++) {
            const revision = this.state().revision;
            const segments: Segment[] = [];
            for (const path of await this.files(this.root)) {
                let batch: NormalizedTelemetryBatch;
                try {
                    const value: unknown = JSON.parse((await readFile(path, "utf8")).trim());
                    if (!isBatch(value)) continue;
                    batch = value;
                } catch { continue; } // Same unreadable/corrupt segment behavior as JSONL storage.
                segments.push(this.project(path, batch));
            }
            const published = this.transaction(() => {
                // A worker changed the projection while files were read: retry from a fresh scan.
                if (this.state().revision !== revision) return false;
                this.db.exec("DELETE FROM segments;");
                for (const segment of segments) this.insertSegment(segment);
                this.publish(true);
                return true;
            });
            if (published) return this.read({})!;
        }
        throw new Error("Overview rebuild raced ongoing ingestion. Retry the rebuild when ingestion is quieter.");
    }

    private project(filePath: string, batch: NormalizedTelemetryBatch): Segment {
        const path = relative(this.root, resolve(filePath));
        if (path === ".." || path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(path)) {
            throw new Error("Overview source must be inside the normalized-event directory.");
        }
        return {
            path,
            digest: createHash("sha256").update(JSON.stringify(batch)).digest("hex"),
            events: batch.events.map(({ runId, type, name, status, startedAt, endedAt, spanId, durationMs, llm }) => ({ runId, type, name, status, startedAt, endedAt, spanId, durationMs, ...(llm ? { llm } : {}) })),
        };
    }

    private insertSegment(segment: Segment): void {
        const id = this.db.prepare("INSERT INTO segments(path, digest) VALUES (?, ?)").run(segment.path, segment.digest).lastInsertRowid;
        segment.events.forEach((event, ordinal) => {
            this.insertEvent.run(id, ordinal, event.runId, event.type, event.name, event.status, event.startedAt, event.endedAt);
            this.insertSpan.run(id, ordinal, event.spanId, event.durationMs);
            if (event.type === "generation") this.insertLlm.run(id, ordinal,
                event.llm?.provider ?? null, event.llm?.model ?? null,
                event.llm?.inputTokens ?? 0, event.llm?.outputTokens ?? 0);
        });
    }

    private predicate(query: TelemetryQuery): { where: string; values: string[] } {
        const clauses: string[] = [];
        const values: string[] = [];
        for (const [key, column, operator] of [
            ["from", "started_at", ">="], ["to", "started_at", "<="],
            ["status", "status", "="], ["type", "type", "="], ["name", "name", "="], ["runId", "run_id", "="],
        ] as const) {
            if (query[key]) { clauses.push(`${column} ${operator} ?`); values.push(query[key]!); }
        }
        return { where: clauses.length ? clauses.join(" AND ") : "1=1", values };
    }

    private calculateTraces(query: TelemetryQuery): Traces {
        const { where, values } = this.predicate(query);
        type Row = Pick<NormalizedTelemetryEvent, "runId" | "type" | "name" | "status" | "startedAt" | "endedAt" | "spanId">;
        const rows = this.db.prepare(`
            SELECT run_id AS runId, type, name, status, started_at AS startedAt, ended_at AS endedAt, span_id AS spanId
            FROM events JOIN span_events USING(segment_id, ordinal)
            WHERE ${where} AND type='run' AND name='openKode-run'
        `).all(...values) as unknown as Row[];
        rows.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.spanId.localeCompare(b.spanId));
        const items = runSummaries(rows);
        return { items, total: items.length };
    }

    private calculateLlm(query: TelemetryQuery): Llm {
        const { where, values } = this.predicate(query);
        type Row = { provider: string | null; model: string | null; inputTokens: number; outputTokens: number;
            durationMs: number; startedAt: string; spanId: string };
        const rows = this.db.prepare(`
            SELECT provider, model, input_tokens AS inputTokens, output_tokens AS outputTokens,
                duration_ms AS durationMs, started_at AS startedAt, span_id AS spanId
            FROM events JOIN span_events USING(segment_id, ordinal) JOIN llm_events USING(segment_id, ordinal)
            WHERE ${where} AND type='generation'
        `).all(...values) as unknown as Row[];
        rows.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.spanId.localeCompare(b.spanId));
        return llmAnalytics(rows.map(row => ({ type: "generation", durationMs: row.durationMs, llm: {
            provider: row.provider ?? "unknown", model: row.model ?? "unknown",
            inputTokens: row.inputTokens, outputTokens: row.outputTokens,
        } })));
    }

    private calculateSpans(query: TelemetryQuery): Spans {
        const { where, values } = this.predicate(query);
        type SpanRow = Pick<NormalizedTelemetryEvent, "type" | "name" | "status" | "durationMs" | "startedAt" | "spanId">;
        const rows = this.db.prepare(`
            SELECT type, name, status, duration_ms AS durationMs, started_at AS startedAt, span_id AS spanId
            FROM events JOIN span_events USING(segment_id, ordinal) WHERE ${where}
        `).all(...values) as unknown as SpanRow[];
        // Preserve the original grouping and tie order, including JS locale comparison.
        rows.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.spanId.localeCompare(b.spanId));
        return spanBreakdown(rows);
    }

    private calculateTimeSeries(query: TelemetryQuery): TimeSeries {
        const { where, values } = this.predicate(query);
        return this.db.prepare(`
            SELECT substr(started_at, 1, 10) AS timestamp, COUNT(DISTINCT run_id) AS runCount,
                COUNT(DISTINCT CASE WHEN status='error' THEN run_id END) AS errorCount
            FROM events WHERE ${where} AND type='run' AND name='openKode-run'
            GROUP BY substr(started_at, 1, 10) ORDER BY timestamp
        `).all(...values).map(row => ({ timestamp: String(row.timestamp), runCount: Number(row.runCount), errorCount: Number(row.errorCount) }));
    }

    private calculate(query: TelemetryQuery): Overview {
        const { where, values } = this.predicate(query);
        const spanCount = Number(this.db.prepare(`SELECT COUNT(*) AS count FROM events WHERE ${where}`).get(...values)!.count);
        const roots = this.db.prepare(`
            SELECT MIN(started_at) AS start, MAX(ended_at) AS end, MAX(CASE WHEN status='error' THEN 1 ELSE 0 END) AS failed
            FROM events WHERE ${where} AND type='run' AND name='openKode-run' GROUP BY run_id
        `).all(...values) as unknown as Array<{ start: string; end: string; failed: number }>;
        const durations = roots.map(row => Date.parse(row.end) - Date.parse(row.start)).sort((a, b) => a - b);
        const errors = roots.filter(row => row.failed).length;
        const percentile = (p: number) => durations[Math.max(0, Math.ceil(durations.length * p / 100) - 1)] ?? 0;
        return { runCount: roots.length, successCount: roots.length - errors, errorCount: errors, spanCount, p50DurationMs: percentile(50), p95DurationMs: percentile(95) };
    }

    private state(): State { return this.db.prepare("SELECT * FROM state WHERE id=1").get() as unknown as State; }

    private publish(ready: boolean): void {
        const payload = JSON.stringify(this.calculate({}));
        this.db.prepare("UPDATE state SET ready=?, revision=revision+1, updated_at=?, payload=? WHERE id=1")
            .run(Number(ready), new Date().toISOString(), payload);
        this.db.prepare("INSERT OR REPLACE INTO timeseries_state VALUES (1, ?, ?)")
            .run(this.state().revision, JSON.stringify(this.calculateTimeSeries({})));
        // Legacy overview rows lack durations until rebuilt. Never publish partial span totals.
        const missing = this.db.prepare(`
            SELECT 1 FROM events LEFT JOIN span_events USING(segment_id, ordinal)
            WHERE span_events.segment_id IS NULL LIMIT 1
        `).get();
        if (missing) this.db.exec("DELETE FROM spans_state");
        else this.db.prepare("INSERT OR REPLACE INTO spans_state VALUES (1, ?, ?)")
            .run(this.state().revision, JSON.stringify(this.calculateSpans({})));
        const missingLlm = this.db.prepare(`
            SELECT 1 FROM events LEFT JOIN span_events USING(segment_id, ordinal)
                LEFT JOIN llm_events USING(segment_id, ordinal)
            WHERE type='generation' AND (span_events.segment_id IS NULL OR llm_events.segment_id IS NULL) LIMIT 1
        `).get();
        if (missingLlm) this.db.exec("DELETE FROM llm_state");
        else this.db.prepare("INSERT OR REPLACE INTO llm_state VALUES (1, ?, ?)")
            .run(this.state().revision, JSON.stringify(this.calculateLlm({})));
        const missingRoots = this.db.prepare(`
            SELECT 1 FROM events LEFT JOIN span_events USING(segment_id, ordinal)
            WHERE type='run' AND name='openKode-run' AND span_events.segment_id IS NULL LIMIT 1
        `).get();
        if (missingRoots) this.db.exec("DELETE FROM traces_state; DELETE FROM trace_runs; DELETE FROM trace_pages_state;");
        else {
            const traces = this.calculateTraces({});
            this.db.prepare("INSERT OR REPLACE INTO traces_state VALUES (1, ?, ?)")
                .run(this.state().revision, JSON.stringify(traces));
            this.db.exec("DELETE FROM trace_runs;");
            const insert = this.db.prepare("INSERT INTO trace_runs VALUES (?, ?, ?, ?, ?)");
            for (const run of traces.items) insert.run(run.runId, run.startedAt, run.endedAt, run.status, run.spanCount);
            this.db.prepare("INSERT OR REPLACE INTO trace_pages_state VALUES (1, ?)").run(this.state().revision);
        }
    }

    private transaction<T>(operation: () => T, mode: "IMMEDIATE" | "DEFERRED" = "IMMEDIATE"): T {
        this.db.exec(`BEGIN ${mode}`);
        try {
            const value = operation();
            this.db.exec("COMMIT");
            return value;
        } catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }

    private async files(directory: string): Promise<string[]> {
        const entries = await readdir(directory, { withFileTypes: true });
        return (await Promise.all(entries.map(entry => entry.isDirectory()
            ? this.files(join(directory, entry.name))
            : entry.isFile() && entry.name.endsWith(".jsonl") ? [join(directory, entry.name)] : []))).flat();
    }
}

function isBatch(value: unknown): value is NormalizedTelemetryBatch {
    return typeof value === "object" && value !== null
        && "batchId" in value && typeof value.batchId === "string"
        && "receivedAt" in value && typeof value.receivedAt === "string"
        && "events" in value && Array.isArray(value.events);
}
