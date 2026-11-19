import type { TelemetryBatch } from "../telemetry/TelemetryEvent.js";
export class OwnershipError extends Error {
    constructor(readonly status: number, message: string) { super(message); }
}
export class Ownership {
    constructor(private readonly url: string, private readonly key: string, private readonly request: typeof fetch = fetch) {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error("SUPABASE_URL must be an HTTPS origin");
    }
    async identity(authorization: string | undefined): Promise<{ id: string; email?: string }> {
        if (!authorization || !/^Bearer [^\s]+$/i.test(authorization)) throw new OwnershipError(401, "Sign-in required");
        const headers = { apikey: this.key, Authorization: authorization, "Content-Type": "application/json" };
        const user = await (await this.send("/auth/v1/user", { headers })).json() as { id?: unknown };
        if (typeof user?.id !== "string") throw new OwnershipError(401, "Invalid identity");
        return { id: user.id, ...(typeof (user as { email?: unknown }).email === "string" ? { email: (user as { email: string }).email } : {}) };
    }
    async accept(batch: TelemetryBatch, authorization: string | undefined): Promise<TelemetryBatch> {
        const userId = (await this.identity(authorization)).id;
        const headers = { apikey: this.key, Authorization: authorization!, "Content-Type": "application/json" };
        const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const registrations = new Map<string, { id: string; session_id: string; installation_id: string; chat_id: string | null }>();
        if (!batch.events.length) throw new OwnershipError(400, "Empty batch");
        const events = batch.events.map(event => {
            if (event.userId !== undefined && event.userId !== userId) throw new OwnershipError(403, "Ownership mismatch");
            if (![event.runId, event.sessionId, event.installationId].every(id => typeof id === "string" && uuid.test(id)) || (event.chatId !== undefined && !uuid.test(event.chatId))) throw new OwnershipError(400, "Missing or invalid ownership IDs");
            const row = { id: event.runId, session_id: event.sessionId!, installation_id: event.installationId!, chat_id: event.chatId ?? null };
            const existing = registrations.get(event.runId);
            if (existing && JSON.stringify(existing) !== JSON.stringify(row)) throw new OwnershipError(403, "Inconsistent run ownership");
            registrations.set(event.runId, row);
            return { ...event, userId };
        });
        await this.send("/rest/v1/rpc/register_telemetry_runs", { method: "POST", headers, body: JSON.stringify({ registrations: [...registrations.values()] }) });
        return { events };
    }
    private async send(endpoint: string, options: RequestInit): Promise<Response> {
        let result: Response;
        try { result = await this.request(`${this.url}${endpoint}`, { ...options, signal: AbortSignal.timeout(10_000), redirect: "error" }); }
        catch { throw new OwnershipError(503, "Identity service unavailable"); }
        if (!result.ok) throw new OwnershipError(result.status === 401 ? 401 : [400, 403, 409].includes(result.status) ? 403 : 503, "Identity or ownership verification failed");
        return result;
    }
}
