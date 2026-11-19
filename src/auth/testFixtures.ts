// Local HTTPS identity service for tests. These credentials are synthetic.
import { createServer } from "node:https";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
export const adminId = "11111111-1111-4111-8111-111111111111";
export async function startIdentityFixture() {
    const certPath = fileURLToPath(new URL("fixtures/cert.pem", import.meta.url));
    const server = createServer({ cert: await readFile(certPath), key: await readFile(new URL("fixtures/key.pem", import.meta.url)) }, (request, response) => {
        const token = request.headers.authorization;
        if (!["Bearer fixture-admin", "Bearer fixture-user"].includes(token ?? "")) { response.writeHead(401).end(); return; }
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ id: token === "Bearer fixture-admin" ? adminId : "22222222-2222-4222-8222-222222222222", email: "fixture@example.com" }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture port");
    return {
        env: { SUPABASE_URL: `https://127.0.0.1:${address.port}`, SUPABASE_PUBLISHABLE_KEY: "fixture-public-key", OPENCOLLECTOR_ADMIN_USER_IDS: adminId,
            NODE_EXTRA_CA_CERTS: certPath, NO_PROXY: "127.0.0.1,localhost,::1", no_proxy: "127.0.0.1,localhost,::1" },
        close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }),
    };
}
export function operatorFetch(input: string | URL | Request, options: RequestInit = {}): Promise<Response> {
    const headers = new Headers(options.headers);
    headers.set("Authorization", "Bearer fixture-admin");
    return globalThis.fetch(input, { ...options, headers });
}
