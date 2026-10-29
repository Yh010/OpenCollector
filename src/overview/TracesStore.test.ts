import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { OverviewStore } from "./OverviewStore.js";
import { NormalizedEventSegmentWriter } from "../processed-events/NormalizedEventSegmentWriter.js";
import type { NormalizedTelemetryEvent } from "../processed-events/NormalizedTelemetryEvent.js";
import { JsonlTelemetryStorage } from "../storage/JsonlTelemetryStorage.js";
import { runSummaries } from "../storage/TelemetryAnalytics.js";
import type { TelemetryQuery } from "../storage/TelemetryStorage.js";

function list(events: NormalizedTelemetryEvent[], status?: "ok" | "error") {
    const items = runSummaries(events).filter(run => !status || run.status === status);
    return { items, total: items.length };
}
async function original(raw: JsonlTelemetryStorage, query: TelemetryQuery) {
    const { status, ...filters } = query;
    return list(await raw.listEvents(filters), status);
}

const receivedAt = "2026-10-22T00:00:00.000Z";
const batch = (batchId: string, events: NormalizedTelemetryEvent[]) => ({ batchId, receivedAt, events });
function event(index: number, extra: Partial<NormalizedTelemetryEvent> = {}): NormalizedTelemetryEvent {
    const startedAt = `2026-10-${index % 2 ? "21" : "22"}T00:00:00.000Z`;
    return { eventId: `e${index}`, spanId: `s${index}`, runId: `r${index}`, type: "run", name: "openKode-run",
        startedAt, endedAt: startedAt, durationMs: index * index + 100, status: index % 3 ? "ok" : "error", receivedAt, ...extra };
}
async function fixture(run: (root: string, store: OverviewStore, writer: NormalizedEventSegmentWriter) => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), "collector-traces-"));
    const store = new OverviewStore(root);
    const writer = new NormalizedEventSegmentWriter({ rootDirectory: root, overview: store });
    try { await run(root, store, writer); }
    finally {
        store.close();
        assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
        await rm(root, { recursive: true });
    }
}

test("trace summaries match JSONL across batches, duplicate roots, dates and every filter", async () => {
    await fixture(async (root, store, writer) => {
        assert.equal(store.readTraces({}), undefined);
        await store.rebuild();
        assert.deepEqual(store.readTraces({})!.result, { items: [], total: 0 });
        const roots = Array.from({ length: 10 }, (_, i) => event(i));
        await writer.write(batch("a", [...roots, event(20, { type: "tool", name: "search" }), event(21, { name: "other-run" })]));
        const split = batch("b", [event(30, { runId: "r1", startedAt: roots[1]!.startedAt }), event(31, { runId: "r1", status: "error" }), event(32, { runId: "r1" })]);
        await writer.write(split);
        const raw = new JsonlTelemetryStorage(root);
        const queries: TelemetryQuery[] = [{}, { status: "error" }, { status: "ok" }, { runId: "r1" },
            { from: "2026-10-22T00:00:00.000Z" }, { to: "2026-10-21T00:00:00.000Z" },
            { from: "2026-10-21", to: "2026-10-22T00:00:00.000Z", runId: "r1", status: "error", type: "run", name: "openKode-run" },
            { type: "tool" }, { type: "run" }, { name: "other-run" }, { name: "openKode-run" }, { runId: "missing" }];
        for (const query of queries) assert.deepEqual(store.readTraces(query)!.result, await original(raw, query), JSON.stringify(query));
        const before = store.readTraces({});
        await writer.write(batch("b", [event(99)]));
        assert.deepEqual(store.readTraces({}), before, "retried batch must not change counts or freshness");
        const reader = new OverviewStore(root);
        try { assert.deepEqual(reader.readTraces({}), before); } finally { reader.close(); }
        const malformed = { ...event(33), name: undefined } as unknown as NormalizedTelemetryEvent;
        assert.throws(() => store.applyBatch(join(root, "bad.jsonl"), batch("bad", [malformed])));
        assert.deepEqual(store.readTraces({}), before);
        await unlink(join(root, "2026-10-22", "b.jsonl"));
        await writeFile(join(root, "2026-10-22", "a.jsonl"), JSON.stringify(batch("a", [event(50)])));
        await store.rebuild();
        assert.deepEqual(store.readTraces({})!.result, list([event(50)]));
    });
});

test("upgrading a legacy projection and an older writer cannot serve stale trace summaries", async () => {
    await fixture(async (root, store, writer) => {
        await store.rebuild();
        await writer.write(batch("a", [event(1)]));
        const database = new DatabaseSync(join(root, ".overview.sqlite"));
        try {
            database.exec("DROP TABLE traces_state; DELETE FROM span_events;");
            const upgraded = new OverviewStore(root);
            try {
                assert.ok(upgraded.read({}));
                assert.equal(upgraded.readTraces({}), undefined);
                await writer.write(batch("new", [event(2)]));
                assert.equal(upgraded.readTraces({}), undefined, "partial backfill must not publish incomplete counts");
                await upgraded.rebuild();
                assert.deepEqual(upgraded.readTraces({})!.result, list([event(1), event(2)]));
                database.exec("UPDATE state SET revision=revision+1 WHERE id=1");
                assert.equal(upgraded.readTraces({}), undefined);
                await upgraded.rebuild();
                assert.deepEqual(upgraded.readTraces({})!.result, list([event(1), event(2)]));
            } finally { upgraded.close(); }
        } finally { database.close(); }
    });
});

test("a rebuild overlapping ingestion retains the new batch in trace summaries", async () => {
    await fixture(async (root, store, writer) => {
        await store.rebuild();
        await writer.write(batch("old", [event(1)]));
        const rebuilding = store.rebuild();
        await writer.write(batch("new", [event(2)]));
        await rebuilding;
        assert.deepEqual(store.readTraces({})!.result, list(await new JsonlTelemetryStorage(root).listEvents({})));
    });
});



test("trace status applies after combining roots; descendants and event filters preserve existing semantics", async () => {
    await fixture(async (root, store, writer) => {
        await store.rebuild();
        await writer.write(batch("a", [
            event(1, { runId: "split", status: "ok", endedAt: "2026-10-21T00:00:01.000Z" }),
            event(2, { runId: "child-error", status: "ok", startedAt: "2026-10-21T00:00:00.000Z" }),
            event(3, { runId: "child-error", type: "tool", name: "failed-tool", status: "error" }),
            event(4, { runId: "other-root", type: "run", name: "custom-run" }),
        ]));
        await writer.write(batch("b", [event(5, { runId: "split", status: "error", startedAt: "2026-10-22T00:00:00.000Z", endedAt: "2026-10-22T00:00:02.000Z" })]));
        const raw = new JsonlTelemetryStorage(root);
        for (const query of [{}, { status: "ok" as const }, { status: "error" as const }, { status: "error" as const, from: "2026-10-22" }, { type: "tool" as const }, { name: "failed-tool" }])
            assert.deepEqual(store.readTraces(query)!.result, await original(raw, query));
        const failed = store.readTraces({ status: "error" })!.result;
        assert.equal(failed.total, 1);
        assert.deepEqual(failed.items[0], { runId: "split", startedAt: "2026-10-21T00:00:00.000Z", endedAt: "2026-10-22T00:00:02.000Z", durationMs: 86402000, status: "error", spanCount: 2 });
        assert.equal(store.readTraces({ status: "ok" })!.result.items[0]!.runId, "child-error");
        const recent = store.readTraces({ from: "2026-10-22" })!.result.items[0]!;
        assert.equal(recent.spanCount, 1);
        assert.equal(recent.durationMs, 2000);
    });
});

test("trace list returns all rows and preserves newest-first ordering and equal-time ties", async () => {
    await fixture(async (root, store, writer) => {
        await store.rebuild();
        await writer.write(batch("many", Array.from({ length: 1001 }, (_, i) => event(i, { spanId: `span-${i}` }))));
        const expected = await original(new JsonlTelemetryStorage(root), {});
        const actual = store.readTraces({})!.result;
        assert.deepEqual(actual, expected);
        assert.equal(actual.total, 1001);
        assert.equal(actual.items.length, 1001);
    });
});


test("cursor pages traverse ties and every filter without duplicates or missing runs", async () => {
    await fixture(async (root, store, writer) => {
        await store.rebuild();
        await writer.write(batch("many", Array.from({ length: 123 }, (_, i) => event(i))));
        await writer.write(batch("split", [event(999, { runId: "r1", status: "error" })]));
        const raw = new JsonlTelemetryStorage(root);
        for (const query of [{}, { status: "error" as const }, { status: "ok" as const },
            { from: "2026-10-22" }, { to: "2026-10-21T23:59:59Z" }, { type: "run" as const },
            { type: "generation" as const }, { name: "openKode-run" }, { name: "missing" }, { runId: "r1" },
            { from: "2026-10-21", status: "error" as const }, { runId: "missing" }]) {
            const expected = (await original(raw, query)).items.sort((a, b) => Buffer.compare(Buffer.from(b.startedAt), Buffer.from(a.startedAt)) || Buffer.compare(Buffer.from(b.runId), Buffer.from(a.runId)));
            const collected: typeof expected = [];
            let cursor: string | undefined;
            let pages = 0;
            do {
                const page = store.readTracePage(query, { limit: 7, ...(cursor ? { cursor } : {}) })!.result;
                assert.equal(page.total, expected.length);
                assert.ok(page.items.length <= 7);
                collected.push(...page.items);
                cursor = page.nextCursor ?? undefined;
                assert.ok(++pages < 30);
            } while (cursor);
            assert.deepEqual(collected, expected, JSON.stringify(query));
            assert.equal(new Set(collected.map(run => run.runId)).size, collected.length);
            for (const pageNumber of new Set([1, Math.max(1, Math.ceil(expected.length / 7)), Math.max(1, Math.ceil(expected.length / 14))])) {
                const jumped = store.readTracePage(query, { limit: 7, page: pageNumber })!.result;
                assert.deepEqual(jumped.items, expected.slice((pageNumber - 1) * 7, pageNumber * 7));
                if (jumped.cursor) assert.deepEqual(store.readTracePage(query, { limit: 7, cursor: jumped.cursor })!.result.items, jumped.items);
            }
            assert.throws(() => store.readTracePage(query, { limit: 7, page: Math.max(1, Math.ceil(expected.length / 7)) + 1 }));
        }
    });
});

test("cursor validation, index readiness and newer inserts preserve the page boundary", async () => {
    await fixture(async (root, store, writer) => {
        assert.equal(store.readTracePage({}, { limit: 5 }), undefined);
        await store.rebuild();
        await writer.write(batch("a", Array.from({ length: 21 }, (_, i) => event(i))));
        const first = store.readTracePage({}, { limit: 5 })!.result;
        const cursor = first.nextCursor!;
        const second = store.readTracePage({}, { limit: 5, cursor })!.result;
        for (const limit of [0, 201, 1.5, NaN]) assert.throws(() => store.readTracePage({}, { limit }));
        assert.throws(() => store.readTracePage({}, { limit: 5, cursor: "garbage" }));
        assert.throws(() => store.readTracePage({ status: "error" }, { limit: 5, cursor }));
        assert.throws(() => store.readTracePage({}, { limit: 6, cursor }));
        await writer.write(batch("new", [event(50, { startedAt: "2026-10-23T00:00:00.000Z" })]));
        assert.deepEqual(store.readTracePage({}, { limit: 5, cursor })!.result.items, second.items);
        const before = store.readTracePage({}, { limit: 5 });
        const malformed = { ...event(99), name: undefined } as unknown as NormalizedTelemetryEvent;
        assert.throws(() => store.applyBatch(join(root, "bad.jsonl"), batch("bad", [malformed])));
        assert.deepEqual(store.readTracePage({}, { limit: 5 }), before);
        const db = new DatabaseSync(join(root, ".overview.sqlite"));
        try { db.exec("DELETE FROM trace_pages_state"); } finally { db.close(); }
        assert.equal(store.readTracePage({}, { limit: 5 }), undefined);
        await store.rebuild();
        assert.equal(store.readTracePage({}, { limit: 5 })!.result.total, 22);
    });
});
