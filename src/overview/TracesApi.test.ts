import { startIdentityFixture, operatorFetch as fetch } from "../auth/testFixtures.js";
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OverviewStore } from "./OverviewStore.js";
import { runSummaries } from "../storage/TelemetryAnalytics.js";

function list(events: Parameters<typeof runSummaries>[0]) {
    const items = runSummaries(events);
    return { items, total: items.length };
}

const slowAnalysisTest = process.env.SLOW_ANALYSIS_TEST === "true";
for (const environment of slowAnalysisTest ? ["test"] : ["test", "production"]) {
test(`HTTP traces and comparison mode (${environment})`, { timeout: slowAnalysisTest ? 130_000 : 30_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "collector-traces-http-"));
    const events = Array.from({ length: 101 }, (_, index) => ({
        eventId: `e${index}`, runId: `r${index}`, spanId: `s${index}`, type: "run" as const, name: "openKode-run",
        startedAt: new Date(Date.UTC(2026, 9, 20, 0, index)).toISOString(), endedAt: new Date(Date.UTC(2026, 9, 20, 0, index, 1)).toISOString(),
        metadata: index === 0 ? { task: "Write login", finalOutput: "Recorded final response", input: { token: "do-not-forward" } } : {},
        status: index ? "error" as const : "ok" as const, receivedAt: "2026-10-22T00:00:00.000Z", durationMs: 1000,
    }));
    await writeFile(join(root, "source.jsonl"), JSON.stringify({ batchId: "test", receivedAt: "2026-10-22T00:00:00.000Z", events }));
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const address = reservation.address();
    assert.ok(address && typeof address !== "string");
    const port = address.port;
    await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
    let modelCalls = 0;
    let unsupported = false;
    const model = createHttpServer(async (request, response) => {
        let body = "";
        for await (const chunk of request) body += String(chunk);
        const context = JSON.parse(JSON.parse(body).messages[1].content);
        assert.equal(context.runId, "r0");
        assert.equal(context.spans[0].metadata.finalOutput, "Recorded final response");
        assert.ok(!body.includes("do-not-forward"));
        modelCalls++;
        if (slowAnalysisTest && modelCalls === 1) {
            console.log("Testing an Ollama response delayed 92 seconds (former timeout: 90 seconds)...");
            await new Promise(resolve => setTimeout(resolve, 92_000));
        }
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ done: true, message: { content: JSON.stringify({ summary: "This run completed.",
            findings: [{ kind: "observation", text: "The run succeeded.", spanIds: [unsupported ? "invented-span" : "s0"] }], nextSteps: [], limitations: [] }) } }));
    });
    model.listen(0, "127.0.0.1");
    await once(model, "listening");
    const modelAddress = model.address();
    assert.ok(modelAddress && typeof modelAddress !== "string");
    const auth = await startIdentityFixture();
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../index.ts", import.meta.url))], {
        cwd: fileURLToPath(new URL("../../", import.meta.url)),
        env: { ...process.env, ...auth.env, PORT: String(port), TRACES_PRECOMPUTED: "true", NODE_ENV: environment, TRACE_ANALYSIS_OLLAMA_URL: `http://127.0.0.1:${modelAddress.port}/api/chat`, PERFORMANCE_DEMO_ENABLED: "true", NORMALIZED_EVENTS_DIR: root, DASHBOARD_ORIGIN: "http://localhost:5173", REDIS_URL: "redis://127.0.0.1:1" },
        stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    let output = "";
    child.stderr.on("data", data => { output += String(data); });
    try {
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`API startup timed out: ${output}`)), 10_000);
            child.stdout.on("data", data => {
                output += String(data);
                if (output.includes("[OpenCollector] Listening")) { clearTimeout(timer); resolve(); }
            });
            child.once("error", error => { clearTimeout(timer); reject(error); });
            child.once("exit", () => { clearTimeout(timer); reject(new Error(output)); });
        });
        const get = (query = "") => fetch(`http://127.0.0.1:${port}/v1/telemetry/traces${query}`);
        const fallback = await get();
        assert.equal(fallback.status, 503);
        const unreadyDetail = await fetch(`http://127.0.0.1:${port}/v1/telemetry/traces/r0`);
        assert.equal(unreadyDetail.status, 503);
        assert.equal(fallback.headers.get("retry-after"), "2");
        for (const query of ["?limit=0", "?limit=201", "?limit=1.5", "?cursor=", "?cursor=invalid", "?page=0", "?page=-1", "?page=1.5", "?page=1&cursor=abc"]) {
            assert.equal((await get(query)).status, 400);
        }
        const analyze = (id: string, origin = "http://localhost:5173") => fetch(`http://127.0.0.1:${port}/v1/telemetry/traces/${id}/analyze`, { method: "POST", headers: { Origin: origin } });
        assert.equal((await analyze("r0")).status, 503);
        const projection = new OverviewStore(root);
        try { await projection.rebuild(); } finally { projection.close(); }
        for (const [query, expected] of [
            ["", list(events)], ["?status=error", list(events.filter(event => event.status === "error"))],
            ["?runId=r0", list(events.filter(event => event.runId === "r0"))],
        ] as const) {
            const response = await get(query);
            assert.equal(response.status, 200);
            assert.equal(response.headers.get("x-traces-source"), "precomputed");
            assert.ok(response.headers.get("x-traces-updated-at"));
            assert.match(response.headers.get("server-timing")!, /files;desc="0 segment files scanned"/);
            const page = await response.json() as { items: unknown[]; total: number; nextCursor: string | null; limit: number };
            assert.deepEqual(page.items, expected.items.slice(0, 50));
            assert.equal(page.total, expected.total);
            assert.equal(page.limit, 50);
            assert.equal(Boolean(page.nextCursor), expected.total > 50);
        }
        if (environment === "production") {
            assert.equal((await get("?optimizations=off")).status, 400);
        } else {
        const baseline = await get("?optimizations=off&limit=50");
        assert.equal(baseline.status, 200);
        assert.equal(baseline.headers.get("x-traces-source"), "live-baseline");
        assert.deepEqual(await baseline.json(), list(events));
        assert.match(baseline.headers.get("server-timing")!, /files;desc="1 segment files scanned"/);
        for (const endpoint of ["overview", "spans", "timeseries", "llm"]) {
            const response = await fetch(`http://127.0.0.1:${port}/v1/telemetry/analytics/${endpoint}?optimizations=off`);
            assert.equal(response.status, 200);
            assert.equal(response.headers.get(`x-${endpoint}-source`), "live-baseline");
            assert.match(response.headers.get("server-timing")!, /files;desc="1 segment files scanned"/);
        }
        const baselineDetail = await fetch(`http://127.0.0.1:${port}/v1/telemetry/traces/r0?optimizations=off`);
        assert.equal(baselineDetail.status, 200);
        assert.equal(baselineDetail.headers.get("x-trace-source"), "live-baseline");
        }
        assert.equal((await analyze("r0", "http://foreign.example")).status, 403);
        assert.equal((await analyze("missing")).status, 404);
        assert.equal(modelCalls, 0);
        const analysis = await analyze("r0");
        assert.equal(analysis.status, 200);
        assert.equal(analysis.headers.get("cache-control"), "no-store");
        const explanation = await analysis.json() as { runId: string; findings: { spanIds: string[] }[] };
        assert.equal(explanation.runId, "r0");
        assert.deepEqual(explanation.findings[0]!.spanIds, ["s0"]);
        assert.equal(modelCalls, 1);
        unsupported = true;
        assert.equal((await analyze("r0")).status, 502);
        const collected: unknown[] = [];
        let cursor: string | null = null;
        do {
            const response = await get(`?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
            const body = await response.json() as { items: unknown[]; total: number; nextCursor: string | null };
            assert.equal(body.total, 101);
            assert.ok(body.items.length <= 20);
            collected.push(...body.items);
            cursor = body.nextCursor;
        } while (cursor);
        assert.deepEqual(collected, list(events).items);
        const jumped = await (await get("?limit=20&page=4")).json() as { items: unknown[]; cursor: string };
        assert.deepEqual(jumped.items, list(events).items.slice(60, 80));
        assert.ok(jumped.cursor);
        assert.equal((await get("?limit=20&page=7")).status, 400);
        const first = await (await get("?limit=20")).json() as { nextCursor: string };
        assert.equal((await get(`?limit=20&status=error&cursor=${first.nextCursor}`)).status, 400);
        assert.equal((await get(`?limit=21&cursor=${first.nextCursor}`)).status, 400);
        const detail = await fetch(`http://127.0.0.1:${port}/v1/telemetry/traces/r0`);
        assert.equal(detail.status, 200);
        const detailBody = await detail.json() as { runId: string; events: unknown[] };
        assert.equal(detailBody.runId, "r0");
        assert.equal(detailBody.events.length, 1);
        assert.equal(detail.headers.get("x-trace-source"), "indexed-jsonl");
        assert.match(detail.headers.get("server-timing")!, /files;desc="1 segment files scanned"/);
        const missingDetail = await fetch(`http://127.0.0.1:${port}/v1/telemetry/traces/not-found`);
        assert.equal(missingDetail.status, 404);
        assert.match(missingDetail.headers.get("server-timing")!, /files;desc="0 segment files scanned"/);
    } finally {
        const exited = once(child, "exit");
        const force = setTimeout(() => child.kill("SIGKILL"), 1000);
        child.kill("SIGTERM");
        if (child.exitCode === null && child.signalCode === null) await exited;
        clearTimeout(force);
        await auth.close();
        await new Promise<void>(resolve => model.close(() => resolve()));
        assert.ok(resolve(root).startsWith(resolve(tmpdir()) + (process.platform === "win32" ? "\\" : "/")));
        await rm(root, { recursive: true });
    }
});

}
