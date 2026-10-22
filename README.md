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

## Temporary dashboard performance dataset

Run `npm run perf:seed` from this project to add 10,000 deterministic synthetic traces (100,000 events: 1 root, 3 worker steps, 3 generations, and 3 tool calls per trace). The dataset contains 9,000 successful and 1,000 failed runs, synthetic token usage, and varied durations across October 15-22, 2026.

This seeds normalized read-side fixtures directly; it does not call real models, queue ingestion jobs, or modify existing telemetry. IDs start with `perf-dummy-`; model names and event metadata identify the data as synthetic. Data is stored in a separate `perf-dummy-10000` subdirectory of `NORMALIZED_EVENTS_DIR` (default `data/normalized-events`), with one segment per trace. Re-running the seed verifies the same files without adding duplicates. Keep this dataset and file layout fixed when comparing optimizations.

Run `npm run perf:clean` to remove only this dataset using its manifest. It leaves original telemetry intact. Generated data stays ignored by Git.

## Read API timing instrumentation

Trace-list, trace-detail, and analytics JSON responses include `Server-Timing` metrics in milliseconds: `discover` (directory scan), `read` (file-content reads), `parse` (JSON parsing and validation), `filter`, `sort`, `compute` (analytics/trace calculation), `serialize`, and `total` (handler start until response ready, excluding transfer). Additional metrics describe the number of files and events scanned. The configured dashboard origin can read these metrics through the Timing and Resource Timing APIs.

In Chrome: open Network, reload, select a telemetry request, then open Timing and inspect Server Timing. Raw values also appear under Response Headers. These are elapsed wall times, not CPU-only measurements: awaited file reads can include time waiting while other requests execute. Stages accumulate per request; do not add durations across parallel requests. Instrumentation adds a small measurement overhead and does not change the read algorithm or response data.

Run `npm run perf:measure -- --rounds 3` while the collector is running to measure the five dashboard endpoints together and individually. Results are saved to ignored `data/performance/read-api-latest.json`. For stable comparisons, keep data, file layout, workload, and profiler settings fixed; note OS file-cache effects and test order. This command measures API responses, not browser rendering. `npm run test:timings` checks storage behavior and isolation between concurrent measurements.

## Precomputed overview experiment

Requires Node.js 24+. All five initial dashboard endpoints use the SQLite projection: the trace list plus overview, timeseries, spans, and LLM analytics. Trace detail, export and worker analytics retain their original JSONL read paths. Normalized JSONL remains authoritative. The disposable SQLite projection is stored at `.overview.sqlite` under `NORMALIZED_EVENTS_DIR` and is ignored with the other generated data. No database service or extra package is required.

The worker reconciles existing normalized segments before accepting jobs. Each normalized batch write then transactionally replaces that segment's contribution and publishes a precomputed unfiltered response. Retried batches are idempotent; a projection failure fails the worker job so retry can repair a segment already saved to JSONL. Stored minimal event fields support every existing filter without rescanning JSONL. Exact P50/P95 use the same nearest-rank and root-run grouping semantics as the original overview, including roots split across batches; they are not averages of precomputed percentiles.

Run `npm run overview:rebuild` once for existing data, or after manual edits/deletion of normalized files. It rebuilds atomically, including replacements and deletions, while preserving the previous snapshot until publication. It retries if managed ingestion changes the projection during the source scan. `perf:seed` and `perf:clean` automatically run this rebuild so synthetic data does not leave stale totals. Direct filesystem changes otherwise require an explicit rebuild.

Before initial projection readiness, the API uses the original live calculation. Responses expose `X-Overview-Source` (`precomputed` or `live-fallback`) and `X-Overview-Updated-At` for the published summary. A `summary` Server-Timing metric measures the projection query. JSONL `files`/`events` timings remain zero for this path; filtered requests may still scan compact indexed projection rows. Results are eventually consistent with the background worker; the timestamp shows summary freshness. Filtered reads run in one SQLite snapshot, and writers use transactions/WAL so readers never see half-applied batches.

This shifts calculation and storage to the write path: publishing an update currently recalculates the stored overview from the compact projection. Unfiltered reads return its saved JSON; filtered reads calculate exact results from the projection. Larger or highly write-heavy datasets may need further incremental aggregation or asynchronous query execution. `npm run test:overview` verifies filters, percentiles, retries, persistence, rollback, deletions, and rebuild/update overlap.

For a controlled before/after experiment, start an API process with `OVERVIEW_PRECOMPUTED=false` to force the original overview scan (`X-Overview-Source: live-baseline`). The default is enabled. This flag affects only overview reads; the worker keeps the projection current. Run the same measurement command against that process using its `PORT`, then repeat with the default enabled.

## Precomputed daily timeseries experiment

The same worker transaction now publishes daily run/error counts alongside overview. Each day counts distinct root run IDs, with errors counted once even when a run has multiple root events or spans batches. A run with roots on two dates appears once on each date, matching the original implementation. All existing event-level filters are applied before grouping; filtered requests query the compact SQLite projection rather than JSONL. The unfiltered endpoint returns saved JSON.

Existing projections fall back to JSONL until the updated worker or `npm run overview:rebuild` publishes the first daily summary. A revision check also falls back if an older worker updates overview without updating daily counts. Restart both API and worker after upgrading. Manual filesystem edits still require a rebuild. Seed and cleanup rebuild both summaries automatically.

In Network, inspect `timeseries`: `X-Timeseries-Source: precomputed`, `X-Timeseries-Updated-At`, and zero JSONL files scanned in `Server-Timing`. Use `TIMESERIES_PRECOMPUTED=false` for the original read path (`live-baseline`) while keeping overview enabled. The summary adds a grouping query to each worker publication, shifting work from reads to writes; filtered queries remain synchronous SQLite work. `npm run test:timeseries` checks equivalence, filters, update/retry behavior, migration, rollback, and HTTP fallback.

## Precomputed spans experiment

The worker now retains each event's original `durationMs` and span ID in SQLite, alongside existing filter fields. It publishes the unfiltered span breakdown in the same transaction as overview and timeseries. Filtered requests select compact SQLite rows, preserving event-level filter semantics, group order, rounded averages and exact nearest-rank P95 via the existing span calculation. Percentiles are calculated from individual durations, not from per-batch percentiles. Raw JSONL remains authoritative.

Restart API and worker after upgrading. Worker startup or `npm run overview:rebuild` backfills duration rows for existing segments. Until all projected events have durations and a matching summary revision, spans falls back to the original JSONL path. Older worker writes invalidate the saved summary by revision; an update on a partially migrated projection cannot publish incomplete counts. Seed/cleanup rebuild all three summaries. Manual filesystem changes still require a rebuild.

Inspect Network response headers: `X-Spans-Source: precomputed`, `X-Spans-Updated-At`, and zero JSONL files/events scanned in `Server-Timing`. The `summary` stage measures reading the snapshot or calculating a filtered projection query. `SPANS_PRECOMPUTED=false` forces the original file-loading path (with the earlier efficient array grouping retained), identified as `live-baseline`. `npm run test:spans` verifies migration, all filters, exact P95, persistence, retries, rollback, deletions and HTTP fallback.

This shifts work to ingestion: each publication currently recalculates the global span breakdown from SQLite rows. More SQLite storage and worker CPU are required; filtered reads still perform synchronous grouping/sorting. Results reflect the latest completed worker publication. Local benchmark timings vary with host activity and file caching; no browser rendering is measured by the API benchmark.

## Precomputed LLM analytics experiment

LLM grouping now appends events directly instead of copying the group for each addition. The worker also projects provider/model and input/output tokens for every generation event into SQLite, including generations with missing metadata. It publishes the unfiltered LLM summary in the same transaction as the other analytics. Filtered reads query compact rows and use the same calculation and JS event ordering as JSONL. Missing provider/model still becomes `unknown`, empty strings are preserved, missing tokens count as zero, and averages are weighted by individual events, not batch averages. Existing provider/model key semantics remain unchanged.

Restart API and worker after updating. Startup reconciliation or `npm run overview:rebuild` backfills existing data. The API falls back to JSONL until all projected generations have metadata rows and durations. Matching revisions prevent an older worker from leaving a stale summary in use. Manual file edits need an explicit rebuild; fixture seed/cleanup already rebuilds every summary.

Network responses expose `X-Llm-Source: precomputed`, `X-Llm-Updated-At`, and zero JSONL files/events scanned in `Server-Timing`. `summary` measures the saved response or exact filtered query. `LLM_PRECOMPUTED=false` enables the original file-loading path with efficient array grouping (`live-baseline`). `npm run test:llm` covers filters, metadata defaults, provider/model grouping, sums/averages, persistence, retries, rollback, rebuild overlap, migration, and HTTP fallback.

The tradeoff is more SQLite storage and calculation on each worker publication. Unfiltered reads return stored JSON; filtered reads still do synchronous SQLite work. Results reflect the latest completed worker batch. JSONL remains authoritative and trace loading is unchanged.

## Precomputed full trace-list experiment

The worker now saves the complete `{ items, total }` trace-list response in SQLite, in the same transaction as the four analytics summaries. All matching runs are returned; pagination has not been introduced. Each root-run summary preserves earliest start, latest end, duration from those timestamps, any root error, and the original root-event count. Descendant failures and counts retain the existing API semantics. Filtered reads use compact root event rows and the existing run summarizer; JS ordering remains newest start first with the same stable tie behavior. Date, type, name and run-ID filters apply to events before grouping, while status applies after roots are grouped.

Restart API and worker after updating, or run `npm run overview:rebuild` for existing files. Missing root metadata or a stale summary revision causes fallback to the original file-reading path. Seed/cleanup rebuild the trace list with the other summaries; manual filesystem edits require a rebuild. `TRACES_PRECOMPUTED=false` forces the original list API (`live-baseline`).

In Network, inspect `traces`: `X-Traces-Source: precomputed`, `X-Traces-Updated-At`, and zero JSONL files/events scanned in `Server-Timing`. `summary` measures the stored-list read or filtered calculation. All 10k+ rows are still transferred and rendered, so serialization, transfer and browser rendering can now account for a larger share of the time. Trace detail (`/v1/telemetry/traces/{runId}`) is unchanged. `npm run test:traces` verifies exact responses, filters, root grouping, ordering, persistence, retries, rollback, migration, rebuild overlap, HTTP fallback and no truncation.

This adds a full-list JSON snapshot and its calculation to each worker publication. Filtered requests still query/group synchronous SQLite rows, and returned data reflects the latest completed worker batch. JSONL remains authoritative.
