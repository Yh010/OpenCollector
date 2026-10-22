import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--rounds")) throw new Error("Usage: npm run perf:measure -- --rounds 3");
const rounds = Number(args[1] ?? 3);
if (!Number.isInteger(rounds) || rounds < 1) throw new Error("Rounds must be a positive integer");
const base = `http://127.0.0.1:${process.env.PORT ?? 3000}`;
const endpoints = ["traces", "analytics/overview", "analytics/timeseries", "analytics/spans", "analytics/llm"];
const results = [];
const output = resolve("data/performance/read-api-latest.json");
await mkdir(resolve("data/performance"), { recursive: true });

async function measure(endpoint, mode, round) {
    const start = performance.now();
    const response = await fetch(`${base}/v1/telemetry/${endpoint}`, { signal: AbortSignal.timeout(180_000) });
    const bytes = await response.arrayBuffer();
    if (!response.ok) throw new Error(`${endpoint} returned ${response.status}`);
    const header = response.headers.get("server-timing");
    if (!header) throw new Error("Server-Timing missing. Restart the collector with the instrumented code.");
    const timings = {};
    for (const metric of header.split(", ")) {
        const match = metric.match(/^([a-z]+);dur=([0-9.]+)/);
        if (match) timings[match[1]] = Number(match[2]);
    }
    const row = { mode, round, endpoint, elapsedMs: Number((performance.now() - start).toFixed(3)), responseBytes: bytes.byteLength, overviewSource: response.headers.get("x-overview-source"), overviewUpdatedAt: response.headers.get("x-overview-updated-at"), timeseriesSource: response.headers.get("x-timeseries-source"), timeseriesUpdatedAt: response.headers.get("x-timeseries-updated-at"), spansSource: response.headers.get("x-spans-source"), spansUpdatedAt: response.headers.get("x-spans-updated-at"), llmSource: response.headers.get("x-llm-source"), llmUpdatedAt: response.headers.get("x-llm-updated-at"), tracesSource: response.headers.get("x-traces-source"), tracesUpdatedAt: response.headers.get("x-traces-updated-at"), timings, serverTiming: header };
    results.push(row);
    console.log(`${mode} ${round} ${endpoint}: ${row.elapsedMs.toFixed(1)} ms; read=${timings.read?.toFixed(1)} ms; compute=${timings.compute?.toFixed(1)} ms`);
}

const startedAt = new Date().toISOString();
for (let round = 1; round <= rounds; round++) {
    console.log(`Round ${round}/${rounds}: five requests together`);
    await Promise.all(endpoints.map(endpoint => measure(endpoint, "concurrent", round)));
    console.log(`Round ${round}/${rounds}: requests individually`);
    for (const endpoint of endpoints) await measure(endpoint, "individual", round);
    await writeFile(output, JSON.stringify({ startedAt, completedAt: new Date().toISOString(), base, rounds, note: "Elapsed wall times; async read includes event-loop and I/O waits. OS file cache and test order affect comparisons. No browser rendering measured.", results }, null, 2) + "\n");
}
console.log(`Saved ${output}`);
