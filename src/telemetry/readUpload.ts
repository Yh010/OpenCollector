export const MAX_TELEMETRY_UPLOAD_BYTES = 500_000_000;

export class UploadTooLargeError extends Error {
    constructor() { super("Telemetry batch exceeds 500 MB"); }
}

export async function readTelemetryUpload(request: AsyncIterable<Uint8Array | string>, maxBytes = MAX_TELEMETRY_UPLOAD_BYTES): Promise<unknown> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
        const buffer = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > maxBytes) throw new UploadTooLargeError();
        chunks.push(buffer);
    }
    return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
}
