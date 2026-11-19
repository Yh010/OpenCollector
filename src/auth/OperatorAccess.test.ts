import { OperatorAccess } from "./OperatorAccess.js";
import { Ownership, OwnershipError } from "./Ownership.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startIdentityFixture } from "./testFixtures.js";
test("all dashboard routes require a verified approved account", { timeout: 30000 }, async () => {
    const auth = await startIdentityFixture();
    const root = await mkdtemp(join(tmpdir(), "collector-access-"));
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const address = reservation.address();
    assert.ok(address && typeof address !== "string");
    const port = address.port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../index.ts", import.meta.url))], {
        cwd: fileURLToPath(new URL("../../", import.meta.url)), windowsHide: true,
        env: { ...process.env, ...auth.env, PORT: String(port), NORMALIZED_EVENTS_DIR: join(root, "normalized"), RAW_EVENTS_DIR: join(root, "raw"), REDIS_URL: "redis://127.0.0.1:1" },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stderr.on("data", value => { output += value; });
    try {
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`Startup failed: ${output}`)), 10000);
            child.stdout.on("data", value => { if (String(value).includes("Listening")) { clearTimeout(timer); resolve(); } });
            child.once("exit", () => { clearTimeout(timer); reject(new Error(output)); });
        });
        const base = `http://127.0.0.1:${port}`;
        for (const path of ["/v1/telemetry/events", "/v1/auth/me", "/v1/telemetry/traces", "/v1/telemetry/traces/foreign", "/v1/telemetry/analytics/overview", "/v1/telemetry/analytics/llm", "/v1/telemetry/analytics/timeseries", "/v1/telemetry/analytics/spans", "/v1/telemetry/analytics/workers", "/v1/telemetry/export.xlsx", "/v1/telemetry/traces?userId=11111111-1111-4111-8111-111111111111"]) {
            assert.equal((await fetch(base + path)).status, 401, path);
            assert.equal((await fetch(base + path, { headers: { Authorization: "Bearer fixture-user" } })).status, 403, path);
        }
        assert.equal((await fetch(base + "/v1/telemetry/traces/foreign/analyze", { method: "POST" })).status, 401);
        assert.equal((await fetch(base + "/v1/telemetry/traces/foreign/analyze", { method: "POST", headers: { Authorization: "Bearer fixture-user" } })).status, 403);
        assert.equal((await fetch(base + "/v1/auth/me", { headers: { Authorization: "Bearer invalid" } })).status, 401);
        const me = await fetch(base + "/v1/auth/me", { headers: { Authorization: "Bearer fixture-admin" } });
        assert.equal(me.status, 200);
        assert.equal((await me.json() as { email: string }).email, "fixture@example.com");
        assert.equal(me.headers.get("cache-control"), "no-store");
        assert.equal((await fetch(base + "/health")).status, 200);
    } finally {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        const force = setTimeout(() => child.kill("SIGKILL"), 1000);
        if (child.exitCode === null && child.signalCode === null) await exited;
        clearTimeout(force);
        await auth.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("empty operator configuration denies all verified accounts", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const identity = new Ownership("https://example.com", "public", async () => Response.json({ id }));
    await assert.rejects(new OperatorAccess(identity, "").verify("Bearer token"), e => e instanceof OwnershipError && e.status === 403);
    assert.equal((await new OperatorAccess(identity, id).verify("Bearer token")).id, id);
    assert.throws(() => new OperatorAccess(identity, "*"), /UUID/);
});
