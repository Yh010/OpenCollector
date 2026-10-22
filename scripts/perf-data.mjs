import "dotenv/config";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const dataset = "opencollector-perf-10000-v1";
const count = 10_000;
const baseTime = Date.parse("2026-10-22T06:00:00.000Z");
const directory = resolve(process.env.NORMALIZED_EVENTS_DIR ?? "data/normalized-events", "perf-dummy-10000");
const manifestPath = join(directory, "manifest.json");
const filenames = Array.from({ length: count }, (_, index) => `perf-dummy-${String(index + 1).padStart(6, "0")}.jsonl`);
const mode = process.argv[2] ?? "seed";

if (mode !== "seed" && mode !== "remove") throw new Error("Usage: node scripts/perf-data.mjs [seed|remove]");

let manifest;
try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
} catch (error) {
    if (error.code !== "ENOENT") throw error;
}
if (manifest && (manifest.dataset !== dataset || manifest.traceCount !== count)) {
    throw new Error("The fixture directory has an unrecognized manifest; refusing to change it.");
}

if (mode === "remove") {
    if (!manifest) {
        console.log("No temporary performance dataset found. Nothing removed.");
    } else {
        const entries = await readdir(directory);
        const allowed = new Set([...filenames, "manifest.json"]);
        if (entries.some(name => !allowed.has(name))) {
            throw new Error("Unexpected files found in the fixture directory; nothing removed.");
        }
        for (const filename of filenames) {
            try { await unlink(join(directory, filename)); }
            catch (error) { if (error.code !== "ENOENT") throw error; }
        }
        await unlink(manifestPath);
        await rmdir(directory);
        console.log("Removed the temporary 10,000-trace performance dataset. Existing telemetry was preserved.");
    }
} else {
    await mkdir(directory, { recursive: true });
    if (!manifest) {
        if ((await readdir(directory)).length) throw new Error("Fixture directory is not empty; refusing to seed it.");
        await writeFile(manifestPath, JSON.stringify({ dataset, traceCount: count, eventCount: count * 10, baseTime: new Date(baseTime).toISOString() }, null, 2) + "\n", { flag: "wx" });
    }
    let bytes = 0;
    for (let index = 0; index < count; index++) {
        const body = JSON.stringify(makeBatch(index)) + "\n";
        bytes += Buffer.byteLength(body);
        const path = join(directory, filenames[index]);
        try { await writeFile(path, body, { flag: "wx" }); }
        catch (error) {
            if (error.code !== "EEXIST") throw error;
            if (await readFile(path, "utf8") !== body) throw new Error(`Fixture content differs: ${filenames[index]}. Nothing overwritten.`);
        }
    }
    console.log(JSON.stringify({ dataset, directory, traces: count, events: count * 10, successfulRuns: count - Math.ceil(count / 10), failedRuns: Math.ceil(count / 10), segmentFiles: count, bytes, cleanup: "npm run perf:clean" }, null, 2));
}


// Direct fixture writes/removals bypass the worker, so refresh its derived overview too.
const rebuild = spawnSync(process.execPath, [
    fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url)),
    fileURLToPath(new URL("../src/overview/rebuild.ts", import.meta.url)),
], { cwd: fileURLToPath(new URL("../", import.meta.url)), stdio: "inherit", env: process.env });
if (rebuild.error) throw rebuild.error;
if (rebuild.status !== 0) throw new Error("Overview refresh failed. Run npm run overview:rebuild before profiling.");

function makeBatch(index) {
    const runId = `perf-dummy-${String(index + 1).padStart(6, "0")}`;
    const start = baseTime - index * 60_000;
    const duration = 1_500 + (index * 7_919) % 120_000;
    const failed = index % 10 === 0;
    const receivedAt = new Date(start + duration + 100).toISOString();
    const events = [];
    const add = (suffix, type, name, offset, durationMs, parent, status = "ok", extra = {}) => {
        const spanId = `${runId}-${suffix}`;
        events.push({
            eventId: `${spanId}-event`, runId, spanId,
            ...(parent ? { parentSpanId: `${runId}-${parent}` } : {}),
            type, name,
            startedAt: new Date(start + offset).toISOString(),
            endedAt: new Date(start + offset + durationMs).toISOString(),
            durationMs, receivedAt, status,
            metadata: { synthetic: true, dataset, ...(suffix === "root" ? { finalOutput: `Temporary performance fixture ${index + 1}; no real model or tool was called.` } : {}) },
            ...extra,
        });
    };
    add("root", "run", "openKode-run", 0, duration, undefined, failed ? "error" : "ok");
    const workers = ["planner-run", "orchestrator-run", "coder-run"];
    for (let stage = 0; stage < workers.length; stage++) {
        const offset = Math.floor(stage * duration / 3);
        const stageDuration = Math.floor(duration / 3) - 10;
        const generationDuration = Math.floor(stageDuration * 0.6);
        const status = failed && stage === 2 ? "error" : "ok";
        add(`step-${stage}`, "agent_step", workers[stage], offset, stageDuration, "root", status);
        add(`generation-${stage}`, "generation", "fixture-generation", offset + 5, generationDuration, `step-${stage}`, status, {
            llm: { provider: "synthetic", model: `fixture-model-${index % 3 + 1}`, inputTokens: 200 + (index * 37 + stage * 101) % 8_000, outputTokens: 50 + (index * 19 + stage * 43) % 2_000 },
        });
        add(`tool-${stage}`, "tool", ["fixture-search", "fixture-file-read", "fixture-validation"][stage], offset + generationDuration + 10, stageDuration - generationDuration - 10, `step-${stage}`, status);
    }
    return { batchId: runId, receivedAt, events };
}
