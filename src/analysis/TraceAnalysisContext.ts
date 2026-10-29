import type { NormalizedTelemetryEvent } from "../processed-events/NormalizedTelemetryEvent.js";

const MAX_CONTEXT = 20000;
const fields = new Set(["task", "taskDescription", "userRequest", "request", "prompt", "systemPrompt", "messages", "inputMessages",
    "code", "patch", "diff", "input", "output", "result", "response", "finalOutput", "arguments", "args", "toolInput", "toolOutput",
    "error", "errorMessage", "message", "reason", "exitCode", "stderr", "stdout", "stack", "stackTrace", "context", "llm", "tool", "toolName", "filePath", "path"]);
const sensitive = /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|client[_-]?secret|private[_-]?key)$/i;
type Span = { spanId: string; parentSpanId?: string; name: string; type: string; status: string; startedAt: string; endedAt: string; durationMs: number; metadata?: Record<string, unknown> };

export function buildAnalysisContext(events: NormalizedTelemetryEvent[]) {
    const notes: string[] = [];
    let truncatedFields = 0, redactedFields = 0, omittedFields = 0;
    const note = (path: string, action: string) => { if (notes.length < 12) notes.push(`${path.slice(0, 150)}: ${action}`); };
    const scrub = (text: string, path: string, max = 1600) => {
        const clean = text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[redacted private key]")
            .replace(/\bBearer\s+[^\s"',;}]+/gi, "Bearer [redacted]")
            .replace(/\bsk-[\w-]+/g, "[redacted]")
            .replace(/((?:api[_-]?key|password|secret|(?:access[_-]?|refresh[_-]?)?token)["']?\s*[:=]\s*["']?)[^\s,"'};]+/gi, "$1[redacted]");
        if (clean !== text) { redactedFields++; note(path, "credential patterns redacted"); }
        if (clean.length <= max) return clean;
        truncatedFields++; note(path, "shortened; beginning and end retained");
        return `${clean.slice(0, Math.floor(max * .65))}\n[…truncated…]\n${clean.slice(-Math.floor(max * .35))}`;
    };
    const sanitize = (value: unknown, path: string, depth = 0): unknown => {
        if (typeof value === "string") return scrub(value, path);
        if (value === null || typeof value === "boolean" || typeof value === "number") return value;
        if (typeof value !== "object") return undefined;
        if (depth >= 6) { omittedFields++; note(path, "nested content omitted at depth limit"); return "[omitted: depth limit]"; }
        if (Array.isArray(value)) {
            // Recent messages usually contain the current tool observation.
            if (value.length > 16) { omittedFields += value.length - 16; note(path, "only the last 16 items included"); }
            return value.slice(-16).map((v, i) => sanitize(v, `${path}[${i}]`, depth + 1));
        }
        const entries = Object.entries(value);
        if (entries.length > 24) { omittedFields += entries.length - 24; note(path, "only the first 24 fields included"); }
        return Object.fromEntries(entries.slice(0, 24).map(([key, v]) => {
            if (sensitive.test(key)) { redactedFields++; note(`${path}.${key}`, "redacted"); return [key, "[redacted]"]; }
            return [scrub(key, path, 100), sanitize(v, `${path}.${key}`, depth + 1)];
        }));
    };

    const chronological = [...events].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const bySpan = new Map(events.map(event => [event.spanId, event]));
    const ordered = new Set<NormalizedTelemetryEvent>();
    const failures = chronological.filter(event => event.status === "error" || event.type === "error");
    failures.forEach(event => ordered.add(event));
    for (const event of failures) {
        let parent = event.parentSpanId ? bySpan.get(event.parentSpanId) : undefined;
        const seen = new Set<string>();
        while (parent && !seen.has(parent.spanId)) { seen.add(parent.spanId); ordered.add(parent); parent = parent.parentSpanId ? bySpan.get(parent.parentSpanId) : undefined; }
        const index = chronological.indexOf(event);
        chronological.slice(Math.max(0, index - 2), index).forEach(neighbor => ordered.add(neighbor));
    }
    chronological.filter(event => event.type === "run").forEach(event => ordered.add(event));
    [...chronological].sort((a, b) => b.durationMs - a.durationMs).forEach(event => ordered.add(event));

    const selected: NormalizedTelemetryEvent[] = [];
    const spans: Span[] = [];
    let skeletonSize = 0;
    for (const event of ordered) {
        const span: Span = { spanId: event.spanId, ...(event.parentSpanId ? { parentSpanId: event.parentSpanId } : {}), name: scrub(event.name, `${event.spanId}.name`, 200),
            type: event.type, status: event.status, startedAt: event.startedAt, endedAt: event.endedAt, durationMs: event.durationMs };
        const size = JSON.stringify(span).length;
        if (spans.length >= 60 || skeletonSize + size > 9000) continue;
        spans.push(span); selected.push(event); skeletonSize += size;
    }
    const context = { runId: events[0]?.runId, totalEvents: events.length, includedEvents: spans.length, omittedEvents: events.length - spans.length,
        recordedFacts: { errorSpanCount: events.filter(event => event.status === "error").length,
            successfulSpanCount: events.filter(event => event.status === "ok").length,
            synthetic: events.some(event => event.metadata?.synthetic === true) },
        detailsIncluded: 0, truncatedFields: 0, redactedFields: 0, omittedFields: 0, notes, spans };
    // Reserve space for counts/notes; metadata is added in failure/ancestor/neighbor priority order.
    for (let i = 0; i < selected.length; i++) {
        const event = selected[i]!;
        const metadata: Record<string, unknown> = {};
        spans[i]!.metadata = metadata;
        const entries = Object.entries(event.metadata ?? {});
        const priority = (key: string) => /error|reason|stderr|exitCode/i.test(key) ? 0 : /task|prompt|messages|llm|input|request|arguments|args/i.test(key) ? 1 : 2;
        for (const [key, raw] of entries.sort(([a], [b]) => priority(a) - priority(b))) {
            const path = `${event.spanId}.metadata.${key}`;
            if (sensitive.test(key)) { redactedFields++; note(path, "redacted and excluded"); continue; }
            if (!fields.has(key)) {
                if (!["synthetic", "dataset"].includes(key)) { omittedFields++; note(path, "unrelated metadata excluded"); }
                continue;
            }
            if (key === "llm" && raw && typeof raw === "object") {
                const capture = raw as Record<string, unknown>;
                if (capture.inputTruncated || capture.outputTruncated) note(path, "content was already truncated when recorded");
            }
            let value = sanitize(raw, path);
            const serialized = JSON.stringify(value);
            if (serialized && serialized.length > 4000) value = scrub(serialized, path, 3500);
            metadata[key] = value;
            if (JSON.stringify(context).length > MAX_CONTEXT - 1500) {
                delete metadata[key]; omittedFields++; note(path, "excluded to fit the model context budget");
            } else context.detailsIncluded++;
        }
        if (!Object.keys(metadata).length) delete spans[i]!.metadata;
    }
    context.truncatedFields = truncatedFields; context.redactedFields = redactedFields; context.omittedFields = omittedFields;
    if (!spans.some(span => span.metadata)) notes.push("No task, prompt, response, tool payload, code or error details were recorded in the selected spans.");
    return context;
}
