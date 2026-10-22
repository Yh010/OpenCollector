import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { OverviewStore } from "./OverviewStore.js";
import { NormalizedEventSegmentWriter } from "../processed-events/NormalizedEventSegmentWriter.js";
import type { NormalizedTelemetryBatch } from "../processed-events/NormalizedEventSegmentWriter.js";
import type { NormalizedTelemetryEvent } from "../processed-events/NormalizedTelemetryEvent.js";
import { JsonlTelemetryStorage } from "../storage/JsonlTelemetryStorage.js";
import { overview } from "../storage/TelemetryAnalytics.js";
import type { TelemetryQuery } from "../storage/TelemetryStorage.js";

function event(index: number, extra: Partial<NormalizedTelemetryEvent> = {}): NormalizedTelemetryEvent {
    const startedAt = new Date(Date.UTC(2026, 9, 21, 0, index)).toISOString();
    const endedAt = new Date(Date.parse(startedAt) + index * 100 + 1000).toISOString();
    return { eventId: `e${index}`, runId: `r${index}`, spanId: `s${index}`, type: "run", name: "openKode-run", startedAt, endedAt, status: index % 3 ? "ok" : "error", receivedAt: "2026-10-22T00:00:00.000Z", durationMs: Date.parse(endedAt) - Date.parse(startedAt), ...extra };
}
const batch = (id: string, events: NormalizedTelemetryEvent[]): NormalizedTelemetryBatch => ({ batchId: id, receivedAt: "2026-10-22T00:00:00.000Z", events });

async function fixture(run: (root: string, store: OverviewStore, writer: NormalizedEventSegmentWriter) => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), "collector-overview-"));
    const store = new OverviewStore(root);
    const writer = new NormalizedEventSegmentWriter({ rootDirectory: root, overview: store });
    try { await run(root, store, writer); }
    finally {
        store.close();
        assert.ok(resolve(root).startsWith(resolve(tmpdir()) + (process.platform === "win32" ? "\\" : "/")));
        await rm(root, { recursive: true });
    }
}

test("overview is unavailable until initial rebuild; committed batches update its persisted response", async () => {
    await fixture(async (root, store, writer) => {
        assert.equal(store.read({}), undefined);
        await store.rebuild();
        assert.deepEqual(store.read({})!.result, overview([]));
        const data = batch("first", [event(1), event(2, { type: "generation", name: "model", status: "error" })]);
        await writer.write(data);
        assert.deepEqual(store.read({})!.result, overview(data.events));
        const reader = new OverviewStore(root);
        try { assert.deepEqual(reader.read({}), store.read({})); }
        finally { reader.close(); }
        // The same persisted batch wins on retries, even if a retried job supplies different contents.
        await writer.write(batch("first", [event(9)]));
        assert.deepEqual(store.read({})!.result, overview(data.events));
        const readerAfterRetry = new OverviewStore(root);
        try { assert.deepEqual(readerAfterRetry.read({})!.result, overview(data.events)); }
        finally { readerAfterRetry.close(); }
    });
});

test("all filters and combinations match the existing implementation, including exact P50/P95 and split roots", async () => {
    await fixture(async (root, store, writer) => {
        await store.rebuild();
        const roots = Array.from({ length: 21 }, (_, i) => event(i));
        const spans = roots.map((e, i) => event(i + 100, { runId: e.runId, type: i % 2 ? "tool" : "generation", name: i % 2 ? "search" : "model", startedAt: e.startedAt }));
        await writer.write(batch("a", [...roots, ...spans]));
        await writer.write(batch("b", [event(24, { runId: "r1", status: "error" }), event(25, { runId: "r1" })]));
        const queries: TelemetryQuery[] = [
            {}, { status: "ok" }, { status: "error" }, { from: roots[4]!.startedAt }, { to: roots[12]!.startedAt },
            { from: roots[4]!.startedAt, to: roots[12]!.startedAt }, { runId: "r1" }, { runId: "missing" },
            { type: "run" }, { type: "generation" }, { type: "tool" }, { name: "openKode-run" }, { name: "search" },
            { status: "error", type: "run", name: "openKode-run", runId: "r1", from: roots[0]!.startedAt, to: event(30).startedAt },
            { status: "ok", type: "tool", name: "search", from: roots[2]!.startedAt, to: roots[18]!.startedAt },
        ];
        const raw = new JsonlTelemetryStorage(root);
        for (const query of queries) assert.deepEqual(store.read(query)!.result, overview(await raw.listEvents(query)), JSON.stringify(query));
    });
});

test("rebuild imports existing segments, applies replacements/deletions, and ignores corrupt files", async () => {
    await fixture(async (root, store, writer) => {
        await writer.write(batch("kept", [event(1)]));
        await writer.write(batch("removed", [event(2)]));
        await writeFile(join(root, "corrupt.jsonl"), "not json");
        await writeFile(join(root, "invalid-shape.jsonl"), "{}");
        await store.rebuild();
        const removedPath = join(root, "2026-10-22", "removed.jsonl");
        await unlink(removedPath);
        const keptPath = join(root, "2026-10-22", "kept.jsonl");
        const replacement = batch("kept", [event(5, { status: "error" })]);
        await writeFile(keptPath, JSON.stringify(replacement));
        await store.rebuild();
        assert.deepEqual(store.read({})!.result, overview(replacement.events));
        const persisted = JSON.parse(await readFile(keptPath, "utf8")) as NormalizedTelemetryBatch;
        await store.applyBatch(keptPath, persisted);
        assert.deepEqual(store.read({})!.result, overview(replacement.events));
        await unlink(keptPath);
        await store.rebuild();
        assert.deepEqual(store.read({})!.result, overview([]));
    });
});

test("two projection connections see updates and failed transactions preserve the previous summary", async () => {
    await fixture(async (root, store, writer) => {
        await store.rebuild();
        const reader = new OverviewStore(root);
        try {
            await writer.write(batch("valid", [event(1)]));
            const before = reader.read({})!;
            const malformed = { ...event(3), name: undefined } as unknown as NormalizedTelemetryEvent;
            assert.throws(() => store.applyBatch(join(root, "bad.jsonl"), batch("bad", [malformed])));
            assert.deepEqual(reader.read({}), before);
            await writer.write(batch("next", [event(2)]));
            assert.equal(reader.read({})!.result.runCount, 2);
        } finally { reader.close(); }
    });
});

test("rebuild overlapping a worker update does not overwrite the newly committed batch", async () => {
    await fixture(async (root, store, writer) => {
        await store.rebuild();
        await writer.write(batch("old", [event(1)]));
        const rebuild = store.rebuild();
        await writer.write(batch("new", [event(2)]));
        await rebuild;
        assert.deepEqual(store.read({})!.result, overview(await new JsonlTelemetryStorage(root).listEvents({})));
        assert.equal(store.read({})!.result.runCount, 2);
    });
});
