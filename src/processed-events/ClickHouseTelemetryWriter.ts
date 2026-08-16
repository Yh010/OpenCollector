import type { NormalizedTelemetryEvent } from "./NormalizedTelemetryEvent.js";

export interface ClickHouseTelemetryWriterOptions {
    url: string;
    username: string;
    password: string;
    database: string;
}

export class ClickHouseTelemetryWriter {
    private readonly endpoint: URL;
    private readonly authorization: string;

    constructor(private readonly options: ClickHouseTelemetryWriterOptions) {
        this.endpoint = new URL(options.url);
        this.authorization = `Basic ${Buffer.from(`${options.username}:${options.password}`).toString("base64")}`;

        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.database)) {
            throw new Error("CLICKHOUSE_DATABASE must be a valid identifier");
        }
    }

    async initialize(): Promise<void> {
        await this.execute(`
            CREATE TABLE IF NOT EXISTS ${this.options.database}.telemetry_events (
                event_id String,
                run_id String,
                span_id String,
                parent_span_id Nullable(String),
                event_type LowCardinality(String),
                event_name String,
                started_at DateTime64(3, 'UTC'),
                ended_at DateTime64(3, 'UTC'),
                received_at DateTime64(3, 'UTC'),
                duration_ms UInt64,
                status LowCardinality(String),
                metadata_json String
            )
            ENGINE = ReplacingMergeTree
            PARTITION BY toYYYYMM(started_at)
            ORDER BY (run_id, started_at, span_id, event_id)
        `);
    }

    async write(events: NormalizedTelemetryEvent[]): Promise<void> {
        if (events.length === 0) {
            return;
        }

        const rows = events.map((event) => JSON.stringify({
            event_id: event.eventId,
            run_id: event.runId,
            span_id: event.spanId,
            parent_span_id: event.parentSpanId ?? null,
            event_type: event.type,
            event_name: event.name,
            started_at: formatClickHouseDateTime(event.startedAt),
            ended_at: formatClickHouseDateTime(event.endedAt),
            received_at: formatClickHouseDateTime(event.receivedAt),
            duration_ms: event.durationMs,
            status: event.status,
            metadata_json: JSON.stringify(event.metadata ?? {}),
        })).join("\n");

        await this.execute(
            `INSERT INTO ${this.options.database}.telemetry_events FORMAT JSONEachRow`,
            rows,
        );
    }

    private async execute(query: string, body?: string): Promise<void> {
        const url = new URL(this.endpoint);
        url.searchParams.set("database", this.options.database);

        if (body !== undefined) {
            url.searchParams.set("query", query);
        }

        const response = await fetch(url, {
            method: "POST",
            headers: {
                Authorization: this.authorization,
                "Content-Type": "text/plain; charset=utf-8",
            },
            body: body ?? query,
        });

        if (!response.ok) {
            throw new Error(`ClickHouse request failed: ${response.status} ${await response.text()}`);
        }
    }
}

function formatClickHouseDateTime(value: string): string {
    return new Date(value).toISOString().slice(0, 23).replace("T", " ");
}
