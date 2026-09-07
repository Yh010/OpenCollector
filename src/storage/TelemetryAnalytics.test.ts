import assert from "node:assert/strict";
import test from "node:test";
import { buildTraceTree, overview, summarizeRuns } from "./TelemetryAnalytics.js";

const event = (overrides: Record<string, unknown> = {}) => ({
    eventId: "event-1", runId: "run-1", spanId: "root", type: "run" as const, name: "openKode-run",
    startedAt: "2026-09-07T10:00:00.000Z", endedAt: "2026-09-07T10:00:01.000Z", receivedAt: "2026-09-07T10:00:01.100Z", durationMs: 1000, status: "ok" as const, ...overrides,
});

test("summarizes a run and reports failed descendants", () => {
    const events = [event(), event({ eventId: "event-2", spanId: "child", parentSpanId: "root", type: "generation", status: "error", durationMs: 500 })];
    assert.deepEqual(summarizeRuns(events), [{ runId: "run-1", startedAt: "2026-09-07T10:00:00.000Z", endedAt: "2026-09-07T10:00:01.000Z", durationMs: 1000, status: "error", spanCount: 2 }]);
    assert.equal(overview(events).errorCount, 1);
    assert.equal(buildTraceTree(events)[0]?.children.length, 1);
});
