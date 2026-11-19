import assert from "node:assert/strict";
import test from "node:test";
import { SupabaseTelemetryStorage } from "./SupabaseTelemetryStorage.js";

test("hosted reads retain caller credentials and traverse keyset pages until the frozen upper bound", async () => {
    const event = { eventId: "e", runId: "run", spanId: "s", type: "run", name: "openKode-run", status: "ok",
        startedAt: "2026-11-19T00:00:00.000Z", endedAt: "2026-11-19T00:00:01.000Z" };
    const queries: URLSearchParams[] = [];
    const request = (async (input, options) => {
        assert.equal((options!.headers as Record<string, string>).Authorization, "Bearer operator-jwt");
        assert.equal(options!.redirect, "error");
        const query = new URL(String(input)).searchParams; queries.push(query);
        if (query.get("order") === "sequence.desc") return Response.json([{ sequence: 301 }]);
        const after = query.getAll("sequence").find(value => value.startsWith("gt."));
        const sequence = after === "gt.0" ? 200 : 301;
        return Response.json([{ sequence, received_at: "2026-11-19T00:00:02.000Z", payload: { ...event, eventId: String(sequence) } }]);
    }) as typeof fetch;
    const storage = new SupabaseTelemetryStorage("https://example.supabase.co", "public-key", request);
    const events = await storage.listEvents({ status: "ok", from: event.startedAt }, "Bearer operator-jwt");
    assert.equal(events.length, 2);
    assert.equal(events[0]!.durationMs, 1000);
    assert.equal(queries.length, 3);
    assert.deepEqual(queries[2]!.getAll("sequence"), ["lte.301", "gt.200"]);
    assert.equal(queries[2]!.get("payload->>status"), "eq.ok");
});

test("hosted writes await the database commit and surface failures without leaking database bodies", async () => {
    const storage = new SupabaseTelemetryStorage("https://example.supabase.co", "public", (async (_input, options) => {
        assert.equal(options!.method, "POST");
        assert.deepEqual(JSON.parse(String(options!.body)), { events: [] });
        return new Response("private database detail", { status: 403 });
    }) as typeof fetch);
    await assert.rejects(storage.append({ events: [] }, "Bearer user"), error =>
        error instanceof Error && error.message === "Trace storage rejected the request");
});
