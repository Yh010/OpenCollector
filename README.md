# OpenCollector

OpenCollector is the telemetry ingestion service for OpenKode.

## Current scope

`POST /v1/telemetry/events` validates a batch, writes it to durable raw JSONL storage, and queues it in BullMQ. A separate worker normalizes queued batches into local JSONL read segments.

The localhost read API serves filtered traces, trace trees, and analytics to the separate OpenCollector Dashboard. The dashboard is a consumer of the API; it never receives ingestion events directly.

## Run locally

1. Copy `.env.example` to `.env` and configure Redis.
2. Install dependencies with `pnpm install`.
3. Run `pnpm dev`.
4. In another terminal, run `pnpm worker`.
5. Set OpenKode's `OPENKODE_TELEMETRY_COLLECTOR_URL` to `http://localhost:3000/v1/telemetry/events`.

Run `pnpm worker` alongside the API process. The collector binds to `127.0.0.1` and serves the dashboard API on the same port.

To make previously captured raw segments available to the dashboard, run `pnpm build` followed by `pnpm rebuild-normalized` once. It is safe to re-run: normalized files are keyed by raw batch ID.
