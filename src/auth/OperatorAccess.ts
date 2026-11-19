import { Ownership, OwnershipError } from "./Ownership.js";
export class OperatorAccess {
    private readonly ids: Set<string>;
    constructor(private readonly ownership: Ownership, userIds: string) {
        const ids = userIds.split(",").map(id => id.trim()).filter(Boolean);
        if (ids.some(id => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) throw new Error("OPENCOLLECTOR_ADMIN_USER_IDS must contain Supabase user UUIDs");
        this.ids = new Set(ids);
    }
    async verify(authorization: string | undefined): Promise<{ id: string; email?: string }> {
        const identity = await this.ownership.identity(authorization);
        if (!this.ids.has(identity.id)) throw new OwnershipError(403, "This account does not have dashboard access");
        return identity;
    }
}
