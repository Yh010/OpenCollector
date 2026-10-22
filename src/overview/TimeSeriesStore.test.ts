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
import { timeSeries } from "../storage/TelemetryAnalytics.js";
import type { TelemetryQuery } from "../storage/TelemetryStorage.js";

const receivedAt = "2026-10-22T00:00:00.000Z";
const batch = (batchId: string, events: NormalizedTelemetryEvent[]) => ({ batchId, receivedAt, events });
function event(index: number, extra: Partial<NormalizedTelemetryEvent> = {}): NormalizedTelemetryEvent {
    const startedAt = `2026-10-${index % 2 ? "21" : "22"}T00:00:00.000Z`;
    return { eventId: `e${index}`, spanId: `s${index}`, runId: `r${index}`, type: "run", name: "openKode-run",
        startedAt, endedAt: startedAt, durationMs: 0, status: index % 3 ? "ok" : "error", receivedAt, ...extra };
}
async function fixture(run: (root: string, store: OverviewStore, writer: NormalizedEventSegmentWriter) => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), "collector-timeseries-"));
    const store = new OverviewStore(root);
    const writer = new NormalizedEventSegmentWriter({ rootDirectory: root, overview: store });
    try { await run(root, store, writer); }
    finally {
        store.close();
        assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
        await rm(root, { recursive: true });
    }
}

test("daily counts match JSONL for split/duplicate roots, multiple dates and every existing filter", async () => {
    await fixture(async (root, store, writer) => {
        assert.equal(store.readTimeSeries({}), undefined);
        await store.rebuild();
        assert.deepEqual(store.readTimeSeries({})!.result, []);
        const roots = Array.from({ length: 10 }, (_, i) => event(i));
        await writer.write(batch("a", [...roots, event(20, { type: "tool", name: "search" }), event(21, { name: "other-run" })]));
        const split = batch("b", [event(30, { runId: "r1", startedAt: roots[1]!.startedAt }), event(31, { runId: "r1", status: "error" }), event(32, { runId: "r1" })]);
        await writer.write(split);
        const raw = new JsonlTelemetryStorage(root);
        const queries: TelemetryQuery[] = [{}, { status: "error" }, { status: "ok" }, { runId: "r1" },
            { from: "2026-10-22T00:00:00.000Z" }, { to: "2026-10-21T00:00:00.000Z" },
            { from: "2026-10-21", to: "2026-10-22T00:00:00.000Z", runId: "r1", status: "error", type: "run", name: "openKode-run" },
            { type: "tool" }, { type: "run" }, { name: "other-run" }, { name: "openKode-run" }, { runId: "missing" }];
        for (const query of queries) assert.deepEqual(store.readTimeSeries(query)!.result, timeSeries(await raw.listEvents(query)), JSON.stringify(query));
        const before = store.readTimeSeries({});
        await writer.write(batch("b", [event(99)]));
        assert.deepEqual(store.readTimeSeries({}), before, "retried batch must not change counts or freshness");
        const reader = new OverviewStore(root);
        try { assert.deepEqual(reader.readTimeSeries({}), before); } finally { reader.close(); }
        const malformed = { ...event(33), name: undefined } as unknown as NormalizedTelemetryEvent;
        assert.throws(() => store.applyBatch(join(root, "bad.jsonl"), batch("bad", [malformed])));
        assert.deepEqual(store.readTimeSeries({}), before);
        await unlink(join(root, "2026-10-22", "b.jsonl"));
        await writeFile(join(root, "2026-10-22", "a.jsonl"), JSON.stringify(batch("a", [event(50)])));
        await store.rebuild();
        assert.deepEqual(store.readTimeSeries({})!.result, timeSeries([event(50)]));
    });
});

test("upgrading an overview-only database and an older writer cannot serve stale daily counts", async () => {
    await fixture(async (root, store, writer) => {
        await store.rebuild();
        await writer.write(batch("a", [event(1)]));
        const database = new DatabaseSync(join(root, ".overview.sqlite"));
        try {
            database.exec("DROP TABLE timeseries_state");
            const upgraded = new OverviewStore(root);
            try {
                assert.ok(upgraded.read({}));
                assert.equal(upgraded.readTimeSeries({}), undefined);
                await upgraded.rebuild();
                assert.deepEqual(upgraded.readTimeSeries({})!.result, timeSeries([event(1)]));
                database.exec("UPDATE state SET revision=revision+1 WHERE id=1");
                assert.equal(upgraded.readTimeSeries({}), undefined);
                await upgraded.rebuild();
                assert.deepEqual(upgraded.readTimeSeries({})!.result, timeSeries([event(1)]));
            } finally { upgraded.close(); }
        } finally { database.close(); }
    });
});

test("a rebuild overlapping ingestion retains the new batch in daily counts", async () => {
    await fixture(async (root, store, writer) => {
        await store.rebuild();
        await writer.write(batch("old", [event(1)]));
        const rebuilding = store.rebuild();
        await writer.write(batch("new", [event(2)]));
        await rebuilding;
        assert.deepEqual(store.readTimeSeries({})!.result, timeSeries(await new JsonlTelemetryStorage(root).listEvents({})));
    });
});