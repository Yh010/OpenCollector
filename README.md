# OpenCollector

OpenCollector is the telemetry ingestion service for OpenKode.

## Current scope

`POST /v1/telemetry/events` accepts a JSON body containing an `events` array, validates the raw event shape, logs the accepted batch, and responds with `202 Accepted`.

This first milestone does not persist events. Durable raw-event storage, workers, ClickHouse, and dashboards come later.

## Run locally

1. Copy `.env.example` to `.env` and set `PORT` if required.
2. Install dependencies with `pnpm install`.
3. Run `pnpm dev`.
4. Set OpenKode's `OPENKODE_TELEMETRY_COLLECTOR_URL` to `http://localhost:3000/v1/telemetry/events`.
