const descriptions = {
    index: "Locate trace segment paths in SQLite",
    summary: "Read precomputed analytics / exact filtered projection",
    discover: "Find telemetry files",
    read: "Read file contents (elapsed, includes async wait)",
    parse: "Parse and validate JSON",
    filter: "Filter events",
    sort: "Sort events",
    compute: "Calculate response",
    serialize: "Serialize JSON response",
} as const;
type Stage = keyof typeof descriptions;

export class ReadTimings {
    private readonly startedAt = performance.now();
    private readonly durations: Partial<Record<Stage, number>> = {};
    fileCount = 0;
    eventCount = 0;

    add(stage: Stage, durationMs: number): void {
        this.durations[stage] = (this.durations[stage] ?? 0) + durationMs;
    }

    measure<T>(stage: Stage, operation: () => T): T {
        const start = performance.now();
        try { return operation(); }
        finally { this.add(stage, performance.now() - start); }
    }

    header(): string {
        const stages = (Object.keys(descriptions) as Stage[]).map(stage =>
            `${stage};dur=${(this.durations[stage] ?? 0).toFixed(3)};desc="${descriptions[stage]}"`,
        );
        return [...stages,
            `total;dur=${(performance.now() - this.startedAt).toFixed(3)};desc="Handler until response ready (excludes transfer)"`,
            `files;desc="${this.fileCount} segment files scanned"`,
            `events;desc="${this.eventCount} events scanned before filtering"`,
        ].join(", ");
    }
}
