export interface ClickHouseTelemetryReaderOptions {
    url: string;
    username: string;
    password: string;
    database: string;
}

export interface RunTelemetryEvent {
    eventId: string;
    runId: string;
    spanId: string;
    parentSpanId?: string;
    type: string;
    name: string;
    startedAt: string;
    endedAt: string;
    receivedAt: string;
    durationMs: number;
    status: string;
}

export interface TraceNode {
    event: RunTelemetryEvent;
    children: TraceNode[];
}

export class ClickHouseTelemetryReader {
    private readonly endpoint: URL;
    private readonly authorization: string;

    constructor(private readonly options: ClickHouseTelemetryReaderOptions) {
        this.endpoint = new URL(options.url);
        this.authorization = `Basic ${Buffer.from(`${options.username}:${options.password}`).toString("base64")}`;

        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.database)) {
            throw new Error("CLICKHOUSE_DATABASE must be a valid identifier");
        }
    }

    async getRunEvents(runId: string): Promise<RunTelemetryEvent[]> {
        const url = new URL(this.endpoint);
        url.searchParams.set("database", this.options.database);
        url.searchParams.set("param_runId", runId);

        const response = await fetch(url, {
            method: "POST",
            headers: {
                Authorization: this.authorization,
                "Content-Type": "text/plain; charset=utf-8",
            },
            body: `
                SELECT
                    event_id,
                    run_id,
                    span_id,
                    parent_span_id,
                    event_type,
                    event_name,
                    started_at,
                    ended_at,
                    received_at,
                    duration_ms,
                    status
                FROM ${this.options.database}.telemetry_events
                WHERE run_id = {runId:String}
                ORDER BY started_at ASC, span_id ASC
                FORMAT JSONEachRow
            `,
        });

        if (!response.ok) {
            throw new Error(`ClickHouse request failed: ${response.status} ${await response.text()}`);
        }

        const body = await response.text();
        return body.trim().split("\n").filter(Boolean).map((line) => parseRunTelemetryEvent(JSON.parse(line)));
    }
}

export function buildTraceTree(events: RunTelemetryEvent[]): TraceNode[] {
    const nodes = new Map<string, TraceNode>();
    const roots: TraceNode[] = [];

    for (const event of events) {
        nodes.set(event.spanId, { event, children: [] });
    }

    for (const event of events) {
        const node = nodes.get(event.spanId)!;
        const parent = event.parentSpanId ? nodes.get(event.parentSpanId) : undefined;

        if (parent) {
            parent.children.push(node);
        } else {
            roots.push(node);
        }
    }

    return roots;
}

function parseRunTelemetryEvent(value: Record<string, unknown>): RunTelemetryEvent {
    return {
        eventId: String(value.event_id),
        runId: String(value.run_id),
        spanId: String(value.span_id),
        ...(value.parent_span_id === null ? {} : { parentSpanId: String(value.parent_span_id) }),
        type: String(value.event_type),
        name: String(value.event_name),
        startedAt: String(value.started_at),
        endedAt: String(value.ended_at),
        receivedAt: String(value.received_at),
        durationMs: Number(value.duration_ms),
        status: String(value.status),
    };
}
