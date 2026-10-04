import { serve } from "@hono/node-server";
import { openDb } from "./db.js";
import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 8080);
const db = openDb(process.env.SFO_DB ?? "/data/sfo.db");
const app = createApp({ db, version: process.env.SFO_VERSION ?? "dev" });

const server = serve({ fetch: app.fetch, port }, () => console.log(`sfo control plane on :${port}`));

// Fly sends SIGINT before stopping an idle Machine: close the database so the
// WAL is checkpointed and Litestream has every write.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close();
    db.close();
    process.exit(0);
  });
}
