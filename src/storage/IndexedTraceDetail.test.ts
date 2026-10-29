import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { OverviewStore } from "../overview/OverviewStore.js";
import { NormalizedEventSegmentWriter } from "../processed-events/NormalizedEventSegmentWriter.js";
import type { NormalizedTelemetryEvent } from "../processed-events/NormalizedTelemetryEvent.js";
import { JsonlTelemetryStorage } from "./JsonlTelemetryStorage.js";
import { buildTraceTree } from "./TelemetryAnalytics.js";
import { ReadTimings } from "../performance/ReadTimings.js";

const receivedAt = "2026-10-23T00:00:00.000Z";
const batch = (batchId: string, events: NormalizedTelemetryEvent[]) => ({ batchId, receivedAt, events });
function event(spanId: string, extra: Partial<NormalizedTelemetryEvent> = {}): NormalizedTelemetryEvent {
    return { eventId: spanId, spanId, runId: "selected", type: "tool", name: "search", startedAt: "2026-10-23T00:00:01.000Z",
        endedAt: "2026-10-23T00:00:02.000Z", durationMs: 1000, status: "ok", receivedAt, ...extra };
}
async function fixture(run: (root: string, store: OverviewStore, writer: NormalizedEventSegmentWriter, storage: JsonlTelemetryStorage) => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), "collector-detail-"));
    const store = new OverviewStore(root);
    const writer = new NormalizedEventSegmentWriter({ rootDirectory: root, overview: store });
    try { await run(root, store, writer, new JsonlTelemetryStorage(root)); }
    finally {
        store.close();
        assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
        await rm(root, { recursive: true });
    }
}

test("indexed details preserve full events/tree across batches and read only distinct matching files", async () => {
    await fixture(async (root, store, writer, storage) => {
        assert.equal(store.lookupRunSegments("selected"), undefined);
        await store.rebuild();
        await writer.write(batch("a", [
            event("root", { type: "run", name: "openKode-run", startedAt: "2026-10-23T00:00:00.000Z", metadata: { prompt: "keep full metadata", nested: { values: [1, 2] } } }),
            event("foreign", { runId: "different" }),
        ]));
        const second = batch("b", [
            event("child-b", { parentSpanId: "root", type: "generation", llm: { provider: "test", model: "model", inputTokens: 17, outputTokens: 9, evalDurationNs: 1234 } }),
            event("child-a", { parentSpanId: "root", status: "error", metadata: { output: "full output" } }),
        ]);
        await writer.write(second);
        for (let i = 0; i < 10; i++) await writer.write(batch(`other-${i}`, [event(`other-${i}`, { runId: `other-${i}` })]));
        await writer.write(batch("b", [event("must-not-replace-persisted-data")]));
        const lookup = store.lookupRunSegments("selected")!;
        assert.equal(lookup.paths.length, 2);
        const indexed = new ReadTimings();
        const actual = await storage.listRunEvents("selected", lookup.paths, indexed);
        const baseline = new ReadTimings();
        const expected = await storage.listEvents({ runId: "selected" }, baseline);
        assert.equal(indexed.fileCount, 2);
        assert.equal(indexed.eventCount, 4);
        assert.equal(baseline.fileCount, 12);
        assert.equal(actual.length, 3);
        assert.deepEqual(actual, expected);
        assert.equal(JSON.stringify({ runId: "selected", events: actual, trace: buildTraceTree(actual) }), JSON.stringify({ runId: "selected", events: expected, trace: buildTraceTree(expected) }));
        assert.equal(buildTraceTree(actual)[0]!.children.length, 2);
    });
});

test("missing runs read zero files; missing/corrupt selected segments retain skip behavior", async () => {
    await fixture(async (root, store, writer, storage) => {
        await store.rebuild();
        await writer.write(batch("a", [event("one")]));
        await writer.write(batch("b", [event("two")]));
        const missing = new ReadTimings();
        assert.deepEqual(store.lookupRunSegments("missing")!.paths, []);
        assert.deepEqual(await storage.listRunEvents("missing", [], missing), []);
        assert.equal(missing.fileCount, 0);
        const paths = store.lookupRunSegments("selected")!.paths;
        await writeFile(join(root, paths[0]!), "corrupt JSON");
        assert.deepEqual(await storage.listRunEvents("selected", paths), await storage.listEvents({ runId: "selected" }));
        await unlink(join(root, paths[1]!));
        assert.deepEqual(await storage.listRunEvents("selected", paths), []);
        await store.rebuild();
        assert.deepEqual(store.lookupRunSegments("selected")!.paths, []);
    });
});

test("indexed file paths stay inside normalized storage", async () => {
    await fixture(async (root, _store, _writer, storage) => {
        for (const path of ["../outside.jsonl", "", resolve(root, "file.jsonl")])
            await assert.rejects(storage.listRunEvents("selected", [path]), /inside normalized storage/);
    });
});
