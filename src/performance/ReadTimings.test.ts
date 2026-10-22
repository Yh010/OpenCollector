import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlTelemetryStorage } from "../storage/JsonlTelemetryStorage.js";
import { ReadTimings } from "./ReadTimings.js";

test("timing preserves filtering, sorting, skipped corrupt files, and isolates concurrent requests", async () => {
    const root = await mkdtemp(join(tmpdir(), "collector-timing-"));
    try {
        await mkdir(join(root, "nested"));
        const events = [
            { eventId: "later", runId: "b", spanId: "b", type: "run", name: "openKode-run", startedAt: "2026-10-22T01:00:00Z", endedAt: "2026-10-22T01:00:01Z", status: "error", durationMs: 1000, receivedAt: "2026-10-22T02:00:00Z" },
            { eventId: "earlier", runId: "a", spanId: "a", type: "run", name: "openKode-run", startedAt: "2026-10-21T01:00:00Z", endedAt: "2026-10-21T01:00:01Z", status: "ok", durationMs: 1000, receivedAt: "2026-10-22T02:00:00Z" },
        ];
        await writeFile(join(root, "nested", "valid.jsonl"), JSON.stringify({ batchId: "test", receivedAt: "2026-10-22T02:00:00Z", events }));
        await writeFile(join(root, "corrupt.jsonl"), "invalid JSON");
        await writeFile(join(root, "invalid-shape.jsonl"), "{}");
        const storage = new JsonlTelemetryStorage(root);
        const ok = new ReadTimings();
        const error = new ReadTimings();
        const [okRows, errorRows] = await Promise.all([storage.listEvents({ status: "ok" }, ok), storage.listEvents({ status: "error" }, error)]);
        assert.deepEqual(okRows, [events[1]]);
        assert.deepEqual(errorRows, [events[0]]);
        const all = new ReadTimings();
        assert.deepEqual(await storage.listEvents({}, all), await storage.listEvents({}));
        for (const timing of [ok, error, all]) {
            assert.equal(timing.fileCount, 3);
            assert.equal(timing.eventCount, 2);
            const header = timing.header();
            for (const stage of ["discover", "read", "parse", "filter", "sort", "compute", "serialize", "total"]) {
                const value = header.match(new RegExp(`(?:^|, )${stage};dur=([0-9.]+)`))?.[1];
                assert.ok(value !== undefined && Number.isFinite(Number(value)) && Number(value) >= 0);
            }
        }
    } finally {
        await rm(root, { recursive: true });
    }
});

test("missing telemetry directory still returns empty results with timings", async () => {
    const root = await mkdtemp(join(tmpdir(), "collector-empty-timing-"));
    try {
        const timings = new ReadTimings();
        assert.deepEqual(await new JsonlTelemetryStorage(join(root, "absent")).listEvents({}, timings), []);
        assert.equal(timings.fileCount, 0);
        assert.equal(timings.eventCount, 0);
    } finally {
        await rm(root, { recursive: true });
    }
});
