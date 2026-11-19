import { OwnershipError } from "../auth/Ownership.js";
import type { TelemetryBatch, TelemetryEvent } from "../telemetry/TelemetryEvent.js";
import type { NormalizedTelemetryEvent } from "../processed-events/NormalizedTelemetryEvent.js";
import type { TelemetryQuery } from "./TelemetryStorage.js";

// Uses the caller's JWT, so database RLS remains effective behind the API.
export class SupabaseTelemetryStorage {
    constructor(private readonly url: string, private readonly key: string, private readonly request: typeof fetch = fetch) {}

    async append(batch: TelemetryBatch, authorization: string): Promise<void> {
        await this.send("/rest/v1/rpc/ingest_telemetry_events", authorization, {
            method: "POST", body: JSON.stringify({ events: batch.events }),
        });
    }

    async listEvents(query: TelemetryQuery, authorization: string): Promise<NormalizedTelemetryEvent[]> {
        const parameters = new URLSearchParams({ select: "sequence,received_at,payload", order: "sequence.asc", limit: "200" });
        if (query.from) parameters.append("started_at", `gte.${query.from}`);
        if (query.to) parameters.append("started_at", `lte.${query.to}`);
        if (query.runId) parameters.set("run_id", `eq.${query.runId}`);
        for (const field of ["status", "type", "name"] as const) {
            if (query[field]) parameters.set(`payload->>${field}`, `eq.${query[field]}`);
        }
        // Freeze an upper sequence so new arrivals cannot extend this read forever.
        const upper = new URLSearchParams(parameters);
        upper.set("select", "sequence"); upper.set("order", "sequence.desc"); upper.set("limit", "1");
        const latest = await (await this.send(`/rest/v1/telemetry_events?${upper}`, authorization)).json() as { sequence: number }[];
        if (!latest.length) return [];
        parameters.append("sequence", `lte.${latest[0]!.sequence}`);
        const events: NormalizedTelemetryEvent[] = [];
        let after = 0;
        while (true) {
            const page = new URLSearchParams(parameters);
            page.append("sequence", `gt.${after}`);
            const rows = await (await this.send(`/rest/v1/telemetry_events?${page}`, authorization)).json() as { sequence: number; received_at: string; payload: TelemetryEvent }[];
            if (!rows.length) break;
            if (events.length + rows.length > 20_000) throw new OwnershipError(422, "This view exceeds 20,000 spans. Select a shorter date range.");
            for (const row of rows) events.push({ ...row.payload, receivedAt: row.received_at,
                durationMs: Date.parse(row.payload.endedAt) - Date.parse(row.payload.startedAt) });
            after = rows[rows.length - 1]!.sequence;
            if (after >= latest[0]!.sequence) break;
        }
        return events.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.spanId.localeCompare(b.spanId));
    }

    private async send(path: string, authorization: string, options: RequestInit = {}): Promise<Response> {
        let response: Response;
        try {
            response = await this.request(`${this.url}${path}`, { ...options, headers: {
                apikey: this.key, Authorization: authorization, "Content-Type": "application/json",
            }, redirect: "error", signal: AbortSignal.timeout(15_000) });
        } catch { throw new OwnershipError(503, "Trace storage is unavailable. Retry shortly."); }
        if (!response.ok) throw new OwnershipError(response.status === 401 ? 401 : [400, 403, 409].includes(response.status) ? 403 : 503, "Trace storage rejected the request");
        return response;
    }
}
