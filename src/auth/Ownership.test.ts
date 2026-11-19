import assert from "node:assert/strict";
import { test } from "node:test";
import { Ownership, OwnershipError } from "./Ownership.js";
import { normalizeRawTelemetryBatch } from "../processed-events/normalizeRawTelemetryBatch.js";
import type { TelemetryEvent } from "../telemetry/TelemetryEvent.js";
const id = (n: number) => `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
const event = (): TelemetryEvent => ({ eventId: "event", runId: id(1), spanId: "span", type: "run", name: "test", status: "ok", startedAt: "2026-11-19T00:00:00Z", endedAt: "2026-11-19T00:00:01Z", installationId: id(2), sessionId: id(3), chatId: id(4) });
test("verified identity is assigned and preserved during normalization", async () => {
    let calls = 0;
    const guard = new Ownership("https://example.com", "public", async (_url, options) => {
        calls++;
        assert.equal((options!.headers as Record<string,string>).Authorization, "Bearer token");
        return calls === 1 ? Response.json({ id: id(5) }) : new Response(null, { status: 204 });
    });
    const batch = await guard.accept({ events: [event()] }, "Bearer token");
    assert.equal(batch.events[0]!.userId, id(5));
    const normalized = normalizeRawTelemetryBatch({ ...batch, batchId: "batch", receivedAt: "2026-11-19T00:00:02Z" });
    assert.equal(normalized[0]!.sessionId, id(3));
    assert.equal(normalized[0]!.userId, id(5));
    assert.equal(calls, 2);
});
test("missing token, forged user, inconsistent run context, and missing ownership are rejected", async () => {
    const guard = new Ownership("https://example.com", "public", async () => Response.json({ id: id(5) }));
    for (const [events, token, status] of [
        [[event()], undefined, 401],
        [[{ ...event(), userId: id(9) }], "Bearer token", 403],
        [[event(), { ...event(), sessionId: id(9) }], "Bearer token", 403],
        [[{ ...event(), sessionId: undefined }], "Bearer token", 400],
    ] as const) {
        await assert.rejects(guard.accept({ events: events as unknown as TelemetryEvent[] }, token), error => error instanceof OwnershipError && error.status === status);
    }
});
test("invalid token, database ownership rejection, and network failures fail closed", async () => {
    for (const status of [401, 403, 503]) {
        const guard = new Ownership("https://example.com", "public", async () => new Response("private data", { status }));
        await assert.rejects(guard.accept({ events: [event()] }, "Bearer token"), e => e instanceof OwnershipError && e.status === status && !e.message.includes("private"));
    }
    const guard = new Ownership("https://example.com", "public", async () => { throw new Error("secret"); });
    await assert.rejects(guard.accept({ events: [event()] }, "Bearer token"), e => e instanceof OwnershipError && e.status === 503);
});
