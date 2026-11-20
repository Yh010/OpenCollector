import assert from "node:assert/strict";
import test from "node:test";
import { MAX_TELEMETRY_UPLOAD_BYTES, readTelemetryUpload, UploadTooLargeError } from "./readUpload.js";

test("the collector accepts uploads above the old 1 MB cap", async () => {
    assert.equal(MAX_TELEMETRY_UPLOAD_BYTES, 500_000_000);
    const text = "x".repeat(2_000_000);
    async function* chunks() { yield Buffer.from(JSON.stringify({ text })); }
    assert.deepEqual(await readTelemetryUpload(chunks()), { text });
});

test("the exact byte boundary is accepted and the first extra byte is rejected", async () => {
    const body = Buffer.from(JSON.stringify({ text: "世界" }));
    async function* chunks() { yield body.subarray(0, 11); yield body.subarray(11); }
    assert.deepEqual(await readTelemetryUpload(chunks(), body.length), { text: "世界" });
    await assert.rejects(readTelemetryUpload(chunks(), body.length - 1), UploadTooLargeError);
});

test("the 500 MB cap rejects overflow before concatenating the body", async () => {
    // Reuse one buffer to check the real cap without allocating a 500 MB payload.
    const chunk = Buffer.alloc(1_000_000, 32);
    async function* chunks() { for (let i = 0; i < 501; i++) yield chunk; assert.fail("Must stop on overflow"); }
    await assert.rejects(readTelemetryUpload(chunks()), error => error instanceof UploadTooLargeError && error.message.includes("500 MB"));
});

test("malformed JSON still fails validation", async () => {
    async function* chunks() { yield "invalid JSON"; }
    await assert.rejects(readTelemetryUpload(chunks()), SyntaxError);
});
