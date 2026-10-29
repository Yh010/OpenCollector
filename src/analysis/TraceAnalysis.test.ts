import assert from "node:assert/strict";
import test from "node:test";
import { buildAnalysisContext, groundAnalysis, TraceAnalyzer, TraceAnalysisError, validateAnalysis } from "./TraceAnalysis.js";
import type { NormalizedTelemetryEvent } from "../processed-events/NormalizedTelemetryEvent.js";

const event = (i = 0): NormalizedTelemetryEvent => ({ eventId: `e${i}`, spanId: `s${i}`, runId: "r1", type: "tool", name: "write-file",
    startedAt: "2026-10-27T10:00:00Z", endedAt: "2026-10-27T10:00:01Z", receivedAt: "2026-10-27T10:00:01Z", durationMs: 1000, status: "error",
    metadata: { error: "permission denied; token=secret123", prompt: "NEVER_SEND_PROMPT", code: "NEVER_SEND_CODE", output: "NEVER_SEND_OUTPUT" } });
const result = { summary: "A file write failed.", findings: [{ kind: "observation" as const, text: "The file-write span failed.", spanIds: ["s0"] }], nextSteps: ["Check directory permissions."], limitations: ["The target path was not provided."] };
const response = (value: unknown = result) => new Response(JSON.stringify({ done: true, message: { content: JSON.stringify(value) } }));

test("context includes recorded payloads and prioritizes failures within a bounded sample", () => {
    const events: NormalizedTelemetryEvent[] = Array.from({ length: 100 }, (_, i) => ({ ...event(i), status: "ok" as const }));
    events[99] = event(99);
    const context = buildAnalysisContext(events);
    assert.ok(context.includedEvents <= 60 && context.includedEvents > 0);
    assert.equal(context.omittedEvents, 100 - context.includedEvents);
    assert.equal(context.recordedFacts.errorSpanCount, 1);
    assert.equal(context.recordedFacts.successfulSpanCount, 99);
    assert.equal(context.spans[0]!.spanId, "s99");
    const text = JSON.stringify(context);
    assert.ok(text.includes("NEVER_SEND_PROMPT"));
    assert.ok(text.includes("NEVER_SEND_CODE"));
    assert.ok(text.includes("NEVER_SEND_OUTPUT"));
    assert.ok(!text.includes("secret123"));
    assert.ok(text.includes("[redacted]"));
});
test("analysis accepts only citations to supplied spans and bounded structured output", () => {
    assert.deepEqual(validateAnalysis(result, new Set(["s0"])), result);
    assert.throws(() => validateAnalysis(result, new Set(["other"])), TraceAnalysisError);
    assert.throws(() => validateAnalysis({ ...result, nextSteps: "not an array" }, new Set(["s0"])), TraceAnalysisError);
    assert.throws(() => validateAnalysis({ ...result, findings: [null] }, new Set(["s0"])), TraceAnalysisError);
});
test("local model receives separated instructions and data, and returns source metadata", async () => {
    const analyzer = new TraceAnalyzer({ fetch: async (url, options) => {
        assert.equal(String(url), "http://127.0.0.1:11434/api/chat");
        const body = JSON.parse(String(options!.body));
        assert.equal(body.stream, false);
        assert.equal(body.options.num_predict, undefined);
        assert.equal(body.messages[0].role, "system");
        assert.equal(body.messages[1].role, "user");
        assert.ok(body.format.properties.findings);
        assert.ok(String(options!.body).includes("NEVER_SEND_PROMPT"));
        assert.ok(!String(options!.body).includes("secret123"));
        return response();
    } });
    const analysis = await analyzer.analyze([event()]);
    assert.equal(analysis.runId, "r1");
    assert.equal(analysis.context.includedEvents, 1);
    assert.deepEqual(analysis.findings, result.findings);
});
test("rejects malformed, unavailable, and external-model responses", async () => {
    for (const fake of [new Response("{}", { status: 500 }), new Response(JSON.stringify({ done: true, message: { content: "invalid json" } }))]) {
        await assert.rejects(new TraceAnalyzer({ fetch: async () => fake }).analyze([event()]), (error: unknown) => error instanceof TraceAnalysisError && error.status === 502);
    }
    await assert.rejects(new TraceAnalyzer({ url: "https://external.example/api/chat" }).analyze([event()]), /local Ollama/);
    await assert.rejects(new TraceAnalyzer({ fetch: async () => { throw new Error("offline"); } }).analyze([event()]), /Cannot reach local Ollama/);
});
test("cancellation releases the single-analysis slot", async () => {
    let calls = 0;
    const analyzer = new TraceAnalyzer({ fetch: async (_url, options) => {
        calls++;
        if (calls > 1) return response();
        return new Promise((_resolve, reject) => {
            const signal = options!.signal!;
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
    } });
    const cancel = new AbortController();
    const pending = analyzer.analyze([event()], cancel.signal);
    await assert.rejects(analyzer.analyze([event()]), (error: unknown) => error instanceof TraceAnalysisError && error.status === 429);
    cancel.abort();
    await assert.rejects(pending, (error: unknown) => error instanceof TraceAnalysisError && error.status === 499);
    assert.equal((await analyzer.analyze([event()])).runId, "r1");

});

test("status-only and synthetic traces cannot present model guesses as causes", () => {
    const unsupported = { ...result, summary: "The tool caused the run to fail.", findings: [{ kind: "possible_cause" as const, text: "The tool caused it.", spanIds: ["s0"] }] };
    const synthetic = groundAnalysis(unsupported, buildAnalysisContext([{ ...event(), metadata: { synthetic: true } }]));
    assert.equal(synthetic.evidenceOnly, true);
    assert.match(synthetic.summary, /synthetic/);
    assert.ok(synthetic.findings.every(f => f.kind === "observation"));
    assert.ok(!JSON.stringify(synthetic).includes("The tool caused"));
    const noDetails = groundAnalysis(unsupported, buildAnalysisContext([{ ...event(), metadata: {} }]));
    assert.equal(noDetails.evidenceOnly, true);
    assert.equal(groundAnalysis(result, buildAnalysisContext([event()])).evidenceOnly, false);
});

test("context preserves recorded nested LLM/tool payloads, task and code while redacting nested secrets", () => {
    const context = buildAnalysisContext([{ ...event(), metadata: {
        task: "Fix login", llm: { inputMessages: [{ role: "system", content: "Recorded system instruction" }, { role: "user", content: "Fix login" }], output: "Use the wrong path", inputTruncated: true },
        input: { path: "src/login.ts", headers: { Authorization: "Bearer sensitive", "X-API-Key": "sensitive" }, password: "sensitive" },
        output: { stderr: "File not found", exitCode: 1 }, code: "const login = true;", apiKey: "sensitive",
        context: { json: '{"token":"sensitive","apiKey":"sensitive"}', privateKey: "-----BEGIN PRIVATE KEY-----sensitive-----END PRIVATE KEY-----" },
    } }]);
    const text = JSON.stringify(context);
    assert.ok(!text.includes("sensitive"));
    assert.ok(text.includes("Recorded system instruction"));
    assert.ok(text.includes("File not found"));
    assert.ok(text.includes("const login = true;"));
    assert.ok(context.redactedFields >= 5);
    assert.ok(context.notes.some(note => note.includes("already truncated")));
});

test("failed span ancestors and preceding successful model/tool steps are retained ahead of unrelated slow spans", () => {
    const many: NormalizedTelemetryEvent[] = Array.from({ length: 80 }, (_, i) => ({ ...event(i), status: "ok", startedAt: new Date(Date.UTC(2026, 9, 27, 10, i)).toISOString(), durationMs: 9999 }));
    many[78] = { ...many[78]!, type: "generation", name: "coder model", metadata: { llm: { inputMessages: [{ role: "user", content: "Use file src/login.ts" }], output: "write missing.ts" } } };
    many[79] = { ...many[79]!, status: "error", parentSpanId: "s0", durationMs: 5, metadata: { error: "No file", input: { path: "missing.ts" } } };
    const context = buildAnalysisContext(many);
    assert.ok(context.spans.some(span => span.spanId === "s79"));
    assert.ok(context.spans.some(span => span.spanId === "s0"));
    assert.ok(context.spans.some(span => span.spanId === "s78" && JSON.stringify(span).includes("write missing.ts")));
});

test("oversized metadata stays bounded and reports truncation, redaction and omissions", () => {
    const events = Array.from({ length: 100 }, (_, i) => ({ ...event(i), metadata: { prompt: "x".repeat(20000), output: "y".repeat(20000), input: Array.from({ length: 100 }, () => ({ token: "sensitive", code: "z".repeat(10000) })), unrelated: "omit this" } }));
    const context = buildAnalysisContext(events);
    assert.ok(JSON.stringify(context).length <= 20000);
    assert.ok(context.truncatedFields > 0);
    assert.ok(context.omittedFields > 0);
    assert.ok(context.omittedEvents > 0);
    assert.ok(context.notes.some(note => note.includes("shortened")));
    assert.ok(!JSON.stringify(context).includes("sensitive"));
    assert.ok(!JSON.stringify(context).includes("omit this"));
});

test("recorded conversation content can be analyzed even without a separate error field", () => {
    const context = buildAnalysisContext([{ ...event(), metadata: { llm: { inputMessages: [{ role: "user", content: "Read config.ts" }], output: "Read nonexistent.ts" } } }]);
    assert.equal(groundAnalysis(result, context).evidenceOnly, false);
});

test("accepts usable JSON regardless of finish flags or response size", async () => {
    for (const metadata of [{ done: false }, { done: true, done_reason: "length" }, {}]) {
        const content = JSON.stringify({ ...result, extraPadding: "x".repeat(21000) });
        const analyzer = new TraceAnalyzer({ fetch: async () => new Response(JSON.stringify({ ...metadata, message: { content } })) });
        const analysis = await analyzer.analyze([event()]);
        assert.equal(analysis.summary, result.summary);
    }
});

test("requests have no application deadline unless the caller cancels", async () => {
    const analyzer = new TraceAnalyzer({ fetch: async (_url, options) => {
        assert.equal(options!.signal, undefined);
        await new Promise(resolve => setTimeout(resolve, 25));
        return response();
    } });
    assert.equal((await analyzer.analyze([event()])).runId, "r1");
});
