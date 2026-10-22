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
import { llmAnalytics } from "../storage/TelemetryAnalytics.js";
import type { TelemetryQuery } from "../storage/TelemetryStorage.js";

const receivedAt = "2026-10-22T00:00:00.000Z";
const batch = (batchId: string, events: NormalizedTelemetryEvent[]) => ({ batchId, receivedAt, events });
function event(index: number, extra: Partial<NormalizedTelemetryEvent> = {}): NormalizedTelemetryEvent {
    const startedAt = `2026-10-${index % 2 ? "21" : "22"}T00:00:00.000Z`;
    return { eventId: `e${index}`, spanId: `s${index}`, runId: `r${index}`, type: "generation", name: "model",
        startedAt, endedAt: startedAt, durationMs: index * index + 100, status: index % 3 ? "ok" : "error", receivedAt, llm: { provider: index % 2 ? "provider-a" : "provider-b", model: `model-${index % 3}`, inputTokens: index * 10, outputTokens: index }, ...extra };
}
async function fixture(run: (root: string, store: OverviewStore, writer: NormalizedEventSegmentWriter) => Promise<void>) {
    const root = await mkdtemp(join(tmpdir(), "collector-llm-"));
    const store = new OverviewStore(root);
    const writer = new NormalizedEventSegmentWriter({ rootDirectory: root, overview: store });
    try { await run(root, store, writer); }
    finally {
        store.close();
        assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
        await rm(root, { recursive: true });
    }
}

test("LLM statistics match JSONL across batches, duplicate roots, dates and every filter", async () => {
    await fixture(async (root, store, writer) => {
        assert.equal(store.readLlm({}), undefined);
        await store.rebuild();
        assert.deepEqual(store.readLlm({})!.result, []);
        const roots = Array.from({ length: 10 }, (_, i) => event(i));
        await writer.write(batch("a", [...roots, event(20, { type: "tool", name: "search" }), event(21, { name: "other-run" })]));
        const split = batch("b", [event(30, { runId: "r1", startedAt: roots[1]!.startedAt }), event(31, { runId: "r1", status: "error" }), event(32, { runId: "r1" })]);
        await writer.write(split);
        const raw = new JsonlTelemetryStorage(root);
        const queries: TelemetryQuery[] = [{}, { status: "error" }, { status: "ok" }, { runId: "r1" },
            { from: "2026-10-22T00:00:00.000Z" }, { to: "2026-10-21T00:00:00.000Z" },
            { from: "2026-10-21", to: "2026-10-22T00:00:00.000Z", runId: "r1", status: "error", type: "generation", name: "model" },
            { type: "tool" }, { type: "generation" }, { type: "run" }, { name: "other-run" }, { name: "model" }, { runId: "missing" }];
        for (const query of queries) assert.deepEqual(store.readLlm(query)!.result, llmAnalytics(await raw.listEvents(query)), JSON.stringify(query));
        const before = store.readLlm({});
        await writer.write(batch("b", [event(99)]));
        assert.deepEqual(store.readLlm({}), before, "retried batch must not change counts or freshness");
        const reader = new OverviewStore(root);
        try { assert.deepEqual(reader.readLlm({}), before); } finally { reader.close(); }
        const malformed = { ...event(33), name: undefined } as unknown as NormalizedTelemetryEvent;
        assert.throws(() => store.applyBatch(join(root, "bad.jsonl"), batch("bad", [malformed])));
        assert.deepEqual(store.readLlm({}), before);
        await unlink(join(root, "2026-10-22", "b.jsonl"));
        await writeFile(join(root, "2026-10-22", "a.jsonl"), JSON.stringify(batch("a", [event(50)])));
        await store.rebuild();
        assert.deepEqual(store.readLlm({})!.result, llmAnalytics([event(50)]));
    });
});

test("upgrading a legacy projection and an older writer cannot serve stale LLM statistics", async () => {
    await fixture(async (root, store, writer) => {
        await store.rebuild();
        await writer.write(batch("a", [event(1)]));
        const database = new DatabaseSync(join(root, ".overview.sqlite"));
        try {
            database.exec("DROP TABLE llm_state; DELETE FROM llm_events;");
            const upgraded = new OverviewStore(root);
            try {
                assert.ok(upgraded.read({}));
                assert.equal(upgraded.readLlm({}), undefined);
                await writer.write(batch("new", [event(2)]));
                assert.equal(upgraded.readLlm({}), undefined, "partial backfill must not publish incomplete counts");
                await upgraded.rebuild();
                assert.deepEqual(upgraded.readLlm({})!.result, llmAnalytics([event(1), event(2)]));
                database.exec("UPDATE state SET revision=revision+1 WHERE id=1");
                assert.equal(upgraded.readLlm({}), undefined);
                await upgraded.rebuild();
                assert.deepEqual(upgraded.readLlm({})!.result, llmAnalytics([event(1), event(2)]));
            } finally { upgraded.close(); }
        } finally { database.close(); }
    });
});

test("a rebuild overlapping ingestion retains the new batch in LLM statistics", async () => {
    await fixture(async (root, store, writer) => {
        await store.rebuild();
        await writer.write(batch("old", [event(1)]));
        const rebuilding = store.rebuild();
        await writer.write(batch("new", [event(2)]));
        await rebuilding;
        assert.deepEqual(store.readLlm({})!.result, llmAnalytics(await new JsonlTelemetryStorage(root).listEvents({})));
    });
});



test("LLM metadata defaults, empty strings, key collisions and weighted event averages match JSONL", async () => {
    await fixture(async (root, store, writer) => {
        await store.rebuild();
        const { llm: _llm, ...missing } = event(10);
        await writer.write(batch("a", [missing, event(11, { llm: {} }),
            event(12, { llm: { provider: "", model: "", inputTokens: 0, outputTokens: 0 } }),
            event(13, { llm: { provider: "a:b", model: "c", inputTokens: 10 }, durationMs: 100 }),
            event(14, { llm: { provider: "weighted", model: "m", inputTokens: 2, outputTokens: 3 }, durationMs: 100 }),
            event(15, { llm: { provider: "weighted", model: "m", inputTokens: 4, outputTokens: 5 }, durationMs: 1000 }),
            event(16, { type: "tool", llm: { provider: "ignored", model: "tool", inputTokens: 999999 } }),
        ]));
        await writer.write(batch("b", [
            event(17, { llm: { provider: "a", model: "b:c", outputTokens: 7 }, durationMs: 500 }),
            event(18, { llm: { provider: "weighted", model: "m", inputTokens: 6, outputTokens: 7 }, durationMs: 2000 }),
        ]));
        const raw = new JsonlTelemetryStorage(root);
        const result = store.readLlm({})!.result;
        assert.deepEqual(result, llmAnalytics(await raw.listEvents({})));
        assert.deepEqual(result.find(group => group.key === "weighted:m"), {
            key: "weighted:m", provider: "weighted", model: "m", count: 3, inputTokens: 12, outputTokens: 15, averageDurationMs: 1033,
        });
        assert.equal(result.find(group => group.key === "unknown:unknown")!.count, 2);
        assert.equal(result.find(group => group.key === ":")!.count, 1);
        assert.equal(result.find(group => group.key === "a:b:c")!.count, 2);
        assert.equal(result.some(group => group.provider === "ignored"), false);
        for (const query of [{ status: "error" as const }, { name: "model" }, { type: "tool" as const }])
            assert.deepEqual(store.readLlm(query)!.result, llmAnalytics(await raw.listEvents(query)));
    });
});
