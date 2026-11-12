import { serve } from "@hono/node-server";
import { openDb } from "./db.js";
import { createApp } from "./app.js";
import { verifyApple } from "./apple.js";
import { Vault, githubOAuth } from "./credentials.js";
import { spriteApi } from "../core/spriteApi.js";
import { expoPush } from "./workers.js";
import { githubDevice } from "./github-signin.js";
import { abandonInterruptedSetups } from "./projects.js";

const port = Number(process.env.PORT ?? 8080);
const db = openDb(process.env.SFO_DB ?? "/data/sfo.db");
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const publicUrl = process.env.SFO_PUBLIC_URL ?? "https://sfo-control.fly.dev";
const sprites = spriteApi(required("SPRITES_TOKEN"));
const setups = new Set<Promise<unknown>>();
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
  sprites,
  setups,
  push: expoPush,
  githubDevice: githubDevice(process.env.GITHUB_CLIENT_ID ?? "Iv23liGwo5OqMwme5fVq"),
  allowedGithub: new Set((process.env.SFO_ALLOWED_GITHUB_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean)),
  webOrigins: (process.env.SFO_WEB_ORIGINS ?? "http://localhost:8081").split(",").map((s) => s.trim()).filter(Boolean),
});

const server = serve({ fetch: app.fetch, port }, () => console.log(`sfo control plane on :${port}`));

abandonInterruptedSetups(db, sprites).then(
  (n) => n > 0 && console.log(`marked ${n} setup(s) interrupted by the last restart as failed`),
  (err) => console.error("could not check for interrupted setups:", err),
);

// Fly sends SIGINT before stopping an idle Machine, and waits kill_timeout
// (fly.toml) before forcing it. Setups still running finish first; then the
// database closes so the WAL is checkpointed and Litestream has every write.
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    server.close();
    if (setups.size > 0) {
      console.log(`waiting for ${setups.size} setup(s) to finish before stopping`);
      await Promise.allSettled([...setups]);
    }
    db.close();
    process.exit(0);
  });
}
