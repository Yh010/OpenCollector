# OpenCollector

OpenCollector is the telemetry ingestion service for OpenKode.

## Current scope

`POST /v1/telemetry/events` validates a batch, writes it to durable raw JSONL storage, and queues it in BullMQ. A separate worker normalizes queued batches and writes them to ClickHouse.

`GET /v1/telemetry/runs/:runId` returns the run's ordered events and trace tree. It intentionally excludes captured LLM payload metadata until API authentication is implemented.

## Run locally

1. Copy `.env.example` to `.env` and configure Redis and ClickHouse.
2. Install dependencies with `pnpm install`.
3. Run `pnpm dev`.
4. In another terminal, run `pnpm worker`.
5. Set OpenKode's `OPENKODE_TELEMETRY_COLLECTOR_URL` to `http://localhost:3000/v1/telemetry/events`.

If OpenCollector must use an HTTPS proxy to reach ClickHouse Cloud, set `OPENCOLLECTOR_HTTPS_PROXY` in `.env`. Corporate `HTTP_PROXY` and `HTTPS_PROXY` settings are intentionally ignored.
