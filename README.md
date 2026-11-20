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

## Cursor pagination (current trace-list contract)

The default trace endpoint now returns `{ items, total, limit, nextCursor }`, with a default limit of 50 and a maximum of 200. Request the next page using `?limit=50&cursor=<nextCursor>`. A null next cursor marks the end. Ordering is `startedAt DESC, runId DESC` using SQLite binary collation, so equal timestamps have a deterministic unique boundary. Cursors are opaque positions bound to the applied filters and limit; invalid/mismatched cursors return 400. They are not authorization tokens or immutable snapshot handles. Newer inserts do not shift an existing cursor boundary; updates/deletions can change later live pages. Refresh starts a new traversal.

The worker publishes an indexed `trace_runs` table and its revision atomically. Unfiltered/status/run-ID pages use that index; event-level date/name/type filters are grouped inside SQLite before applying status and the cursor. SQLite selects at most `limit + 1` rows into JavaScript; it does not load and slice the full list. The matching total excludes the cursor. Cards/charts retain all-match statistics. Before index readiness the default endpoint returns 503 with Retry-After, instead of scanning JSONL. Restart the updated worker or run `overview:rebuild` once to populate the index. The explicit `TRACES_PRECOMPUTED=false` experimental baseline still returns the former full JSONL list and is not for the paginated UI.

The dashboard replaces its 50 rows on Next/Previous, retaining cursor positions rather than previous row arrays. Apply and Refresh start from the first page; navigation fetches only traces using applied filters. Failed page navigation keeps the current rows and cursor. Trace inspector Previous/Next refers to the current page. Export remains across all matching runs. Earlier full-list benchmark sections document the prior experiment, not the current default response.

Trace pages also accept `?limit=50&page=N` for direct jumps. The server locates the previous row with an indexed `LIMIT 1 OFFSET ...` lookup, then performs the usual cursor query. Deep jumps cost more index traversal than Next/Previous; no full list is loaded into JavaScript. Responses include the current `cursor` for subsequent navigation. Page numbers must be positive and within the current total; combining page and cursor returns 400. The dashboard caches cursor positions for visited pages, using a numbered lookup only for an unvisited destination.

## Indexed trace details

`GET /v1/telemetry/traces/{runId}` looks up distinct segment paths through SQLite's existing `event_run` index, then reads only those JSONL files. A run spanning several batches reads every matching segment; shared batches are filtered to that run. Full event metadata, LLM fields, chronological/span ordering, duplicate handling and tree construction are unchanged. Missing runs return 404 without a directory scan. Unreadable/corrupt selected files retain the existing skip behavior. Paths are checked to stay inside normalized storage.

Before initial index readiness, detail requests return 503 with Retry-After instead of scanning everything. The index is maintained by the existing worker transaction/rebuild path; direct manual filesystem changes still require rebuilding. The response remains eventually consistent with the completed worker index. An index lookup and JSONL reads are not a long-lived immutable snapshot; managed segments are immutable.

Network response headers expose `X-Trace-Source: indexed-jsonl` and `X-Trace-Updated-At`. `Server-Timing` adds an `index` stage; files/events counters now describe only the selected segments and their events before run filtering. For a controlled local baseline, `TRACE_DETAIL_INDEXED=false` forces the original full scan (`live-baseline`). `npm run test:trace-detail` checks multi-segment runs, shared batches, full response equivalence, missing runs, corrupt/missing files, retries and path containment.

### Local optimization comparison

The dashboard's Optimizations switch reloads the page. OFF appends `optimizations=off` to read requests: analytics scan JSONL on each request, traces return all matching runs, and trace details scan all segment files. ON uses the usual configured SQLite/indexed paths and cursor pagination. Existing individual environment flags still apply. This compares read paths and pagination; efficient grouping, independent section loading, and current UI remain in both modes. No artificial delay is added. Large unpaginated datasets can make the browser unresponsive; reloading the dashboard without `?optimizations=off` restores the default.

Comparison requests are rejected with HTTP 400 when `NODE_ENV=production` or `PERFORMANCE_DEMO_ENABLED=false`. This is a local demonstration feature, not a production setting. Export behavior is unchanged.

### Analyze one trace with local AI

The inspector's **Analyze with AI** button calls `POST /v1/telemetry/traces/:runId/analyze` (no request body). It always uses the indexed trace lookup, independent of comparison mode. Returns `{runId, model, generatedAt, summary, findings: [{kind, text, spanIds}], nextSteps, limitations, context: {totalEvents, includedEvents, omittedEvents, synthetic}}`. Finding kinds are `observation` and `possible_cause`. References are checked against the spans actually sent; explanations are model suggestions, not verified root causes.

Start local Ollama and install `qwen2.5-coder:3b` with `ollama pull qwen2.5-coder:3b`. Optional `TRACE_ANALYSIS_MODEL` selects another installed model. `TRACE_ANALYSIS_OLLAMA_URL` must be a loopback HTTP endpoint; external providers are not supported by this feature. No AI request occurs during normal dashboard loading.

Analysis includes timings, types, statuses and span identifiers/names, plus recorded task details, prompts/messages, model responses, code excerpts, errors and tool inputs/outputs from selected spans. Metadata is allowlisted at the top level and recursively bounded/redacted; unrelated fields are omitted. Basic credential-pattern redaction is best-effort, not a guarantee that error messages contain no sensitive text. The complete serialized context is limited to roughly 20,000 characters and at most 60 span summaries, reserving about half the space for payloads. Failed spans, their ancestors and two preceding steps are prioritized, followed by roots and slower spans. Text fields retain bounded beginning/end excerpts (normally 1,600 characters); arrays retain their latest 16 entries, objects up to 24 fields and nesting up to six levels. Output context reports detail-field counts, shortened/redacted/omitted counts and sample notes. Upstream capture truncation is also reported when flagged. Overlapping durations must not be added together. Structured output is validated, including references. Model text is rendered as text, not HTML. No tools are exposed to the model.

One analysis runs at a time per collector process (429 otherwise). There is no application-level generation deadline; the UI can cancel and retry, and leaving the trace aborts its request. Results are held only in the mounted inspector, with no persistent cache or history. Error statuses: 403 for foreign dashboard origins, 404 missing trace, 503 unready index/unavailable local model service, 502 invalid/incomplete model output. Dashboard authentication is enforced by the shared operator gate; deployment still needs HTTPS and infrastructure rate limits.

When all recorded diagnostic content is absent or the trace is synthetic, `evidenceOnly: true` marks a deterministic summary of statuses and timings; model-generated cause claims are discarded. Synthetic results direct the user to real traces rather than suggest debugging simulated tools.

Prompt/model-response context uses OpenKode's recorded `metadata.llm.inputMessages` and `metadata.llm.output` fields, along with generic prompt/input/output/code/task fields where recorded. `OPENKODE_TELEMETRY_CAPTURE_LLM_CONTENT=true` controls capture in OpenKode for future runs (off by default); the analyzer does not change that policy or reconstruct missing historical content. Tool inputs/outputs and the original task are available only if their emitting span recorded them. Traces without recorded content explicitly report the gap. The model sees trace content as untrusted data, even when it contains system/user messages or instruction-like strings.

Analysis no longer imposes a 650-token generation cap or rejects answers based on done/done_reason flags or a 20,000-character response-size check. It attempts to parse the returned content; valid JSON with the required analysis fields and supported span references is still required. The input-context budget remains. The former 90-second application timeout has been removed; caller cancellation still works.

## Authenticated ingestion ownership

Ingestion requires a Supabase bearer token. The collector verifies identity,
rejects forged or inconsistent ownership, and registers run ownership through
`register_telemetry_runs` before saving events. Apply OpenKode migration
`202611190002_register_runs.sql` first. Only the user token and public project
key are needed; no service key is used. JSONL normalization preserves the IDs.
Historical events remain unattributed.

## Dashboard operator access

Every dashboard read, trace detail, Excel export, and AI analysis request requires
a Supabase bearer token whose verified user ID is in
`OPENCOLLECTOR_ADMIN_USER_IDS` (comma-separated UUIDs). An empty list denies all
accounts. Find your UUID with `openkode whoami`; set the list in the collector's
private `.env`, then restart the API. Never grant access by trusting a user ID
from a request body, query string, or an unverified decoded JWT.

Ordinary OpenKode users can submit their own verified telemetry without being
dashboard operators. Operators can inspect the whole dataset, including legacy
unowned traces. This is an internal console, not a customer-facing trace portal.
Missing/invalid credentials return 401; verified but unapproved accounts get 403;
identity-service outages fail closed with 503. Only `/health` and CORS preflight
are public. Responses are not cached.

The local dashboard runs at `http://127.0.0.1:5175`; `DASHBOARD_ORIGIN` must match.
Its Google callback allowlist entry is
`http://127.0.0.1:5175/auth/callback/*` in Supabase. The public project key is
sufficient; neither a service-role key nor an admin secret is shipped to browsers.

Run `pnpm test` for the complete collector suite. API tests use a localhost HTTPS
identity fixture and synthetic accounts; the certificate/private key in
`src/auth/fixtures` are test-only, not production credentials. Keep the collector
on loopback until HTTPS/reverse-proxy and deployment limits are configured.

## Render free deployment

Hosted mode starts with `pnpm start:cloud` (`node dist/cloud.js`). It binds
`0.0.0.0:$PORT` and commits each upload to Supabase before returning 202. It
does not use Redis, SQLite, background workers, or the service filesystem.
Local mode (`pnpm start` plus `pnpm worker`) keeps its existing JSONL storage.

1. Apply OpenKode's Supabase migrations through `202611190004_validate_stored_events.sql`.
2. Add the approved operator UUID through the Supabase SQL Editor:
   `insert into public.collector_operators(user_id) values ('YOUR_USER_UUID');`
   Clients cannot grant themselves operator access.
3. Create the free Node web service using `render.yaml`, or build with
   `pnpm install --frozen-lockfile --prod=false && pnpm run build` and start with
   `node dist/cloud.js`. Select Node 24.19.0 and health check `/health`.
4. Set `OPENCOLLECTOR_ADMIN_USER_IDS` to that same UUID and `DASHBOARD_ORIGIN`
   to the actual Vercel production origin. The public Supabase URL/key are
   defaults; do not add a service-role key or database password.
5. Set the dashboard's `VITE_OPENCOLLECTOR_URL` to the Render HTTPS origin,
   rebuild it, and add its exact `/auth/callback/*` URL to Supabase Auth.
6. Set OpenKode's `OPENKODE_TELEMETRY_COLLECTOR_URL` to the Render HTTPS URL
   ending `/v1/telemetry/events`.

All reads require an approved operator JWT. Supabase independently restricts
event reads to the operator table; ordinary users can execute only the checked
ingestion function. Identical event IDs/payloads deduplicate; overwrites fail.
Historical local traces are not uploaded automatically.

This initial hosted reader supports up to 20,000 spans per filtered view. It
returns an explicit error above that limit instead of silently truncating data.
Use a shorter date range; database-side analytics will be needed as usage grows.
Free Render instances sleep when idle, so the first request can be slow. The
CLI allows 90 seconds for HTTPS uploads and retries transient failures once;
delivery is still best-effort if the process exits or the outage continues.

Hosted AI trace analysis returns 503 until a hosted model is configured. Viewing
traces, analytics, and Excel export work without a model. The local AI analysis
path remains available with local Ollama.

Hosted and local ingestion accept request bodies up to 500 MB (500,000,000 bytes). Larger bodies return HTTP 413. This is the application body-size cap; available host memory and upstream service limits also affect large uploads.
