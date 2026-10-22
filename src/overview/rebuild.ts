import "dotenv/config";
import { resolve } from "node:path";
import { OverviewStore } from "./OverviewStore.js";

const store = new OverviewStore(resolve(process.env.NORMALIZED_EVENTS_DIR ?? "data/normalized-events"));
try {
    const startedAt = performance.now();
    const snapshot = await store.rebuild();
    console.log(JSON.stringify({ event: "overview_rebuilt", durationMs: Math.round(performance.now() - startedAt), ...snapshot }, null, 2));
} finally { store.close(); }
