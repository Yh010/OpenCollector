import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OverviewStore } from "./OverviewStore.js";
import { llmAnalytics } from "../storage/TelemetryAnalytics.js";

test("HTTP llm falls back before readiness, then serves exact filtered snapshots without JSONL scans", { timeout: 30_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "collector-llm-http-"));
    const events = [0, 1].map(index => ({
        eventId: `e${index}`, runId: `r${index}`, spanId: `s${index}`, type: "generation" as const, name: "model", llm: { provider: "test", model: `m${index}`, inputTokens: index * 10, outputTokens: index * 3 },
        startedAt: `2026-10-2${index}T00:00:00.000Z`, endedAt: `2026-10-2${index}T00:00:01.000Z`,
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
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../index.ts", import.meta.url))], {
        cwd: fileURLToPath(new URL("../../", import.meta.url)),
        env: { ...process.env, PORT: String(port), LLM_PRECOMPUTED: "true", NORMALIZED_EVENTS_DIR: root, DASHBOARD_ORIGIN: "http://localhost:5173", REDIS_URL: "redis://127.0.0.1:1" },
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
        const get = (query = "") => fetch(`http://127.0.0.1:${port}/v1/telemetry/analytics/llm${query}`);
        const fallback = await get();
        assert.equal(fallback.headers.get("x-llm-source"), "live-fallback");
        assert.deepEqual(await fallback.json(), llmAnalytics(events));
        const projection = new OverviewStore(root);
        try { await projection.rebuild(); } finally { projection.close(); }
        for (const [query, expected] of [
            ["", llmAnalytics(events)], ["?status=error", llmAnalytics(events.filter(event => event.status === "error"))],
            ["?runId=r0", llmAnalytics(events.filter(event => event.runId === "r0"))],
        ] as const) {
            const response = await get(query);
            assert.equal(response.status, 200);
            assert.equal(response.headers.get("x-llm-source"), "precomputed");
            assert.ok(response.headers.get("x-llm-updated-at"));
            assert.match(response.headers.get("server-timing")!, /files;desc="0 segment files scanned"/);
            assert.deepEqual(await response.json(), expected);
        }
    } finally {
        const exited = once(child, "exit");
        const force = setTimeout(() => child.kill("SIGKILL"), 1000);
        child.kill("SIGTERM");
        if (child.exitCode === null && child.signalCode === null) await exited;
        clearTimeout(force);
        assert.ok(resolve(root).startsWith(resolve(tmpdir()) + (process.platform === "win32" ? "\\" : "/")));
        await rm(root, { recursive: true });
    }
});
