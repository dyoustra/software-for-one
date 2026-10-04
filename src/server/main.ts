import { serve } from "@hono/node-server";
import { openDb } from "./db.js";
import { createApp } from "./app.js";
import { verifyApple } from "./apple.js";
import { Vault, githubOAuth } from "./credentials.js";

const port = Number(process.env.PORT ?? 8080);
const db = openDb(process.env.SFO_DB ?? "/data/sfo.db");
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const publicUrl = process.env.SFO_PUBLIC_URL ?? "https://sfo-control.fly.dev";
const app = createApp({
  db,
  vault: new Vault(db, required("SFO_CREDENTIALS_KEY")),
  github: githubOAuth(process.env.GITHUB_CLIENT_ID ?? "Iv23liGwo5OqMwme5fVq", required("GITHUB_CLIENT_SECRET")),
  // The app's return addresses, added as the app gains them (and on the GitHub App).
  githubRedirects: (process.env.SFO_GITHUB_REDIRECTS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  version: process.env.SFO_VERSION ?? "dev",
  verifyApple,
  allowed: new Set((process.env.SFO_ALLOWED_APPLE_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean)),
  publicUrl,
});

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
