import ExcelJS from "exceljs";
import type { NormalizedTelemetryEvent } from "../processed-events/NormalizedTelemetryEvent.js";

export async function createTelemetryWorkbook(events: NormalizedTelemetryEvent[]): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Telemetry events");
    sheet.columns = [
        { header: "Event ID", key: "eventId", width: 40 }, { header: "Run ID", key: "runId", width: 40 },
        { header: "Span ID", key: "spanId", width: 40 }, { header: "Parent span ID", key: "parentSpanId", width: 40 },
        { header: "Type", key: "type", width: 16 }, { header: "Name", key: "name", width: 24 },
        { header: "Started at", key: "startedAt", width: 28 }, { header: "Ended at", key: "endedAt", width: 28 },
        { header: "Received at", key: "receivedAt", width: 28 }, { header: "Duration ms", key: "durationMs", width: 14 },
        { header: "Status", key: "status", width: 12 }, { header: "Provider", key: "provider", width: 16 },
        { header: "Model", key: "model", width: 24 }, { header: "Input tokens", key: "inputTokens", width: 14 },
        { header: "Output tokens", key: "outputTokens", width: 14 }, { header: "Metadata", key: "metadata", width: 80 },
    ];
    for (const event of events) sheet.addRow({ ...event, provider: event.llm?.provider, model: event.llm?.model, inputTokens: event.llm?.inputTokens, outputTokens: event.llm?.outputTokens, metadata: JSON.stringify(event.metadata ?? {}) });
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    sheet.autoFilter = { from: "A1", to: "P1" };
    return Buffer.from(await workbook.xlsx.writeBuffer());
}
