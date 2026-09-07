import type { NormalizedTelemetryEvent } from "../processed-events/NormalizedTelemetryEvent.js";

export interface TraceNode {
    event: NormalizedTelemetryEvent;
    children: TraceNode[];
}

export interface TraceSummary {
    runId: string;
    startedAt: string;
    endedAt: string;
    durationMs: number;
    status: "ok" | "error";
    spanCount: number;
}

export function buildTraceTree(events: NormalizedTelemetryEvent[]): TraceNode[] {
    const nodes = new Map<string, TraceNode>();
    const roots: TraceNode[] = [];
    for (const event of events) nodes.set(event.spanId, { event, children: [] });
    for (const event of events) {
        const node = nodes.get(event.spanId)!;
        const parent = event.parentSpanId ? nodes.get(event.parentSpanId) : undefined;
        if (parent) parent.children.push(node); else roots.push(node);
    }
    return roots;
}

export function summarizeRuns(events: NormalizedTelemetryEvent[]): TraceSummary[] {
    const groups = new Map<string, NormalizedTelemetryEvent[]>();
    for (const event of events) groups.set(event.runId, [...(groups.get(event.runId) ?? []), event]);
    return [...groups.entries()].map(([runId, values]) => {
        const startedAt = values.reduce((value, event) => value < event.startedAt ? value : event.startedAt, values[0]!.startedAt);
        const endedAt = values.reduce((value, event) => value > event.endedAt ? value : event.endedAt, values[0]!.endedAt);
        return { runId, startedAt, endedAt, durationMs: Date.parse(endedAt) - Date.parse(startedAt), status: values.some((event) => event.status === "error") ? "error" as const : "ok" as const, spanCount: values.length };
    }).sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

export function overview(events: NormalizedTelemetryEvent[]) {
    const runs = runSummaries(events);
    const durations = runs.map((run) => run.durationMs);
    return {
        runCount: runs.length,
        successCount: runs.filter((run) => run.status === "ok").length,
        errorCount: runs.filter((run) => run.status === "error").length,
        spanCount: events.length,
        p50DurationMs: percentile(durations, 50),
        p95DurationMs: percentile(durations, 95),
    };
}

export function timeSeries(events: NormalizedTelemetryEvent[]) {
    const runEvents = events.filter(isRootRun);
    const grouped = new Map<string, { timestamp: string; runIds: Set<string>; errorRunIds: Set<string> }>();
    for (const event of runEvents) {
        const timestamp = event.startedAt.slice(0, 10);
        const value = grouped.get(timestamp) ?? { timestamp, runIds: new Set(), errorRunIds: new Set() };
        value.runIds.add(event.runId);
        if (event.status === "error") value.errorRunIds.add(event.runId);
        grouped.set(timestamp, value);
    }
    return [...grouped.values()].map((value) => ({ timestamp: value.timestamp, runCount: value.runIds.size, errorCount: value.errorRunIds.size })).sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

export function workerBreakdown(events: NormalizedTelemetryEvent[]) {
    const workers = new Set(["planner-run", "orchestrator-run", "coder-run"]);
    const grouped = new Map<string, NormalizedTelemetryEvent[]>();
    for (const event of events.filter((event) => event.type === "agent_step" && workers.has(event.name))) {
        grouped.set(event.name, [...(grouped.get(event.name) ?? []), event]);
    }
    return [...grouped.entries()].map(([worker, values]) => ({ worker, executions: values.length, errors: values.filter((event) => event.status === "error").length, averageLatencyMs: Math.round(values.reduce((sum, event) => sum + event.durationMs, 0) / values.length), p50LatencyMs: percentile(values.map((event) => event.durationMs), 50), p95LatencyMs: percentile(values.map((event) => event.durationMs), 95), maxLatencyMs: Math.max(...values.map((event) => event.durationMs)) })).sort((left, right) => right.p95LatencyMs - left.p95LatencyMs);
}

export function runSummaries(events: NormalizedTelemetryEvent[]): TraceSummary[] {
    return summarizeRuns(events.filter(isRootRun));
}

function isRootRun(event: NormalizedTelemetryEvent): boolean {
    return event.type === "run" && event.name === "openKode-run";
}

export function spanBreakdown(events: NormalizedTelemetryEvent[]) {
    const grouped = new Map<string, NormalizedTelemetryEvent[]>();
    for (const event of events) {
        const key = `${event.type}:${event.name}`;
        grouped.set(key, [...(grouped.get(key) ?? []), event]);
    }
    return [...grouped.entries()].map(([key, values]) => ({
        key, type: values[0]!.type, name: values[0]!.name, count: values.length,
        errorCount: values.filter((event) => event.status === "error").length,
        averageDurationMs: Math.round(values.reduce((sum, event) => sum + event.durationMs, 0) / values.length),
        p95DurationMs: percentile(values.map((event) => event.durationMs), 95),
    })).sort((left, right) => right.p95DurationMs - left.p95DurationMs);
}

export function llmAnalytics(events: NormalizedTelemetryEvent[]) {
    const generations = events.filter((event) => event.type === "generation");
    const grouped = new Map<string, NormalizedTelemetryEvent[]>();
    for (const event of generations) {
        const key = `${event.llm?.provider ?? "unknown"}:${event.llm?.model ?? "unknown"}`;
        grouped.set(key, [...(grouped.get(key) ?? []), event]);
    }
    return [...grouped.entries()].map(([key, values]) => ({
        key, provider: values[0]!.llm?.provider ?? "unknown", model: values[0]!.llm?.model ?? "unknown", count: values.length,
        inputTokens: values.reduce((sum, event) => sum + (event.llm?.inputTokens ?? 0), 0),
        outputTokens: values.reduce((sum, event) => sum + (event.llm?.outputTokens ?? 0), 0),
        averageDurationMs: Math.round(values.reduce((sum, event) => sum + event.durationMs, 0) / values.length),
    }));
}

function percentile(values: number[], target: number): number {
    if (!values.length) return 0;
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.min(sorted.length - 1, Math.ceil((target / 100) * sorted.length) - 1)]!;
}
