import "dotenv/config";
import { createServer } from "node:http";
import { parseTelemetryBatch } from "./telemetry/validateTelemetryBatch.js";

const port = parsePort(process.env.PORT);
const maxRequestBytes = 1_000_000;

const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/telemetry/events") {
        response.writeHead(404).end();
        return;
    }

    try {
        const body = await readJsonBody(request, maxRequestBytes);
        const batch = parseTelemetryBatch(body);

        if (!batch) {
            response.writeHead(400, { "Content-Type": "application/json" }).end(
                JSON.stringify({ error: "Invalid telemetry batch" }),
            );
            return;
        }

        console.log({
            event: "telemetry_batch_accepted",
            eventCount: batch.events.length,
        });

        response.writeHead(202).end();
    } catch (error) {
        const statusCode = error instanceof RequestTooLargeError ? 413 : 400;
        response.writeHead(statusCode, { "Content-Type": "application/json" }).end(
            JSON.stringify({ error: error instanceof Error ? error.message : "Invalid request" }),
        );
    }
});

server.listen(port, () => {
    console.log(`[OpenCollector] Listening on http://localhost:${port}`);
});

function parsePort(value: string | undefined): number {
    const port = Number(value ?? 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("PORT must be an integer between 1 and 65535");
    }
    return port;
}

async function readJsonBody(request: import("node:http").IncomingMessage, maxBytes: number): Promise<unknown> {
    let body = "";

    for await (const chunk of request) {
        body += chunk;
        if (Buffer.byteLength(body) > maxBytes) {
            throw new RequestTooLargeError(`Request body exceeds ${maxBytes} bytes`);
        }
    }

    return JSON.parse(body);
}

class RequestTooLargeError extends Error {}
