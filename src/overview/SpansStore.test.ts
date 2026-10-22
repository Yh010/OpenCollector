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
import { spanBreakdown } from "../storage/TelemetryAnalytics.js";
import type { TelemetryQuery } from "../storage/TelemetryStorage.js";

const receivedAt = "2026-10-22T00:00:00.000Z";
const batch = (batchId: string, events: NormalizedTelemetryEvent[]) => ({ batchId, receivedAt, events });
function event(index: number, extra: Partial<NormalizedTelemetryEvent> = {}): NormalizedTelemetryEvent {
    const startedAt = `2026-10-${index % 2 ? "21" : "22"}T00:00:00.000Z`;
    return { eventId: `e${index}`, spanId: `s${index}`, runId: `r${index}`, type: "run", name: "openKode-run",
        startedAt, endedAt: startedAt, durationMs: index * index + 100, status: index % 3 ? "ok" : "error", receivedAt, ...extra };
}
async function fixture(run: (root: string, store: OverviewStore, writer: NormalizedEventSegmentWriter) => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), "collector-spans-"));
    const store = new OverviewStore(root);
    const writer = new NormalizedEventSegmentWriter({ rootDirectory: root, overview: store });
    try { await run(root, store, writer); }
    finally {
        store.close();
        assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
        await rm(root, { recursive: true });
    }
}

test("span statistics match JSONL across batches, duplicate roots, dates and every filter", async () => {
    await fixture(async (root, store, writer) => {
        assert.equal(store.readSpans({}), undefined);
        await store.rebuild();
        assert.deepEqual(store.readSpans({})!.result, []);
        const roots = Array.from({ length: 10 }, (_, i) => event(i));
        await writer.write(batch("a", [...roots, event(20, { type: "tool", name: "search" }), event(21, { name: "other-run" })]));
        const split = batch("b", [event(30, { runId: "r1", startedAt: roots[1]!.startedAt }), event(31, { runId: "r1", status: "error" }), event(32, { runId: "r1" })]);
        await writer.write(split);
        const raw = new JsonlTelemetryStorage(root);
        const queries: TelemetryQuery[] = [{}, { status: "error" }, { status: "ok" }, { runId: "r1" },
            { from: "2026-10-22T00:00:00.000Z" }, { to: "2026-10-21T00:00:00.000Z" },
            { from: "2026-10-21", to: "2026-10-22T00:00:00.000Z", runId: "r1", status: "error", type: "run", name: "openKode-run" },
            { type: "tool" }, { type: "run" }, { name: "other-run" }, { name: "openKode-run" }, { runId: "missing" }];
        for (const query of queries) assert.deepEqual(store.readSpans(query)!.result, spanBreakdown(await raw.listEvents(query)), JSON.stringify(query));
        const before = store.readSpans({});
        await writer.write(batch("b", [event(99)]));
        assert.deepEqual(store.readSpans({}), before, "retried batch must not change counts or freshness");
        const reader = new OverviewStore(root);
        try { assert.deepEqual(reader.readSpans({}), before); } finally { reader.close(); }
        const malformed = { ...event(33), name: undefined } as unknown as NormalizedTelemetryEvent;
        assert.throws(() => store.applyBatch(join(root, "bad.jsonl"), batch("bad", [malformed])));
        assert.deepEqual(store.readSpans({}), before);
        await unlink(join(root, "2026-10-22", "b.jsonl"));
        await writeFile(join(root, "2026-10-22", "a.jsonl"), JSON.stringify(batch("a", [event(50)])));
        await store.rebuild();
        assert.deepEqual(store.readSpans({})!.result, spanBreakdown([event(50)]));
    });
});

test("upgrading a legacy projection and an older writer cannot serve stale spans", async () => {
    await fixture(async (root, store, writer) => {
        await store.rebuild();
        await writer.write(batch("a", [event(1)]));
        const database = new DatabaseSync(join(root, ".overview.sqlite"));
        try {
            database.exec("DROP TABLE spans_state; DELETE FROM span_events;");
            const upgraded = new OverviewStore(root);
            try {
                assert.ok(upgraded.read({}));
                assert.equal(upgraded.readSpans({}), undefined);
                await writer.write(batch("new", [event(2)]));
                assert.equal(upgraded.readSpans({}), undefined, "partial backfill must not publish incomplete counts");
                await upgraded.rebuild();
                assert.deepEqual(upgraded.readSpans({})!.result, spanBreakdown([event(1), event(2)]));
                database.exec("UPDATE state SET revision=revision+1 WHERE id=1");
                assert.equal(upgraded.readSpans({}), undefined);
                await upgraded.rebuild();
                assert.deepEqual(upgraded.readSpans({})!.result, spanBreakdown([event(1), event(2)]));
            } finally { upgraded.close(); }
        } finally { database.close(); }
    });
});

test("a rebuild overlapping ingestion retains the new batch in span statistics", async () => {
    await fixture(async (root, store, writer) => {
        await store.rebuild();
        await writer.write(batch("old", [event(1)]));
        const rebuilding = store.rebuild();
        await writer.write(batch("new", [event(2)]));
        await rebuilding;
        assert.deepEqual(store.readSpans({})!.result, spanBreakdown(await new JsonlTelemetryStorage(root).listEvents({})));
    });
});

test("exact P95 combines individual durations across batches and preserves equal-P95 group order", async () => {
    await fixture(async (root, store, writer) => {
        await store.rebuild();
        const events = Array.from({ length: 41 }, (_, i) => event(i, {
            type: "tool", name: "search", durationMs: i < 40 ? i : 10000,
            startedAt: "2026-10-21T00:00:00.000Z", spanId: `span-${i}`,
        }));
        await writer.write(batch("a", events.slice(0, 20)));
        await writer.write(batch("b", events.slice(20)));
        await writer.write(batch("c", [event(42, { type: "tool", name: "another", durationMs: 38, startedAt: "2026-10-20T00:00:00.000Z" })]));
        const raw = await new JsonlTelemetryStorage(root).listEvents({});
        assert.deepEqual(store.readSpans({})!.result, spanBreakdown(raw));
        const search = store.readSpans({ name: "search" })!.result[0]!;
        assert.equal(search.count, 41);
        assert.equal(search.p95DurationMs, 38);
        assert.deepEqual(store.readSpans({})!.result.map(group => group.name), ["another", "search"]);
    });
});
