import { Hono } from "hono";
import { schemaVersion, type Db } from "./db.js";
import { authRoutes, type AuthDeps, type Env } from "./auth.js";
import { credentialRoutes, type GitHubOAuth, type Vault } from "./credentials.js";

export interface ServerDeps extends Omit<AuthDeps, "db"> {
  db: Db;
  /** The commit this build came from, so a health check says what is running. */
  version: string;
  vault: Vault;
  github: GitHubOAuth;
}

/**
 * The control plane's HTTP API. Every action finishes inside its request: the
 * Machine stops when idle, and Fly never stops one with a request in flight.
 */
export function createApp(deps: ServerDeps): Hono<Env> {
  const app = new Hono<Env>();

  app.get("/health", (c) => c.json({ ok: true, version: deps.version, schema: schemaVersion(deps.db) }));
  authRoutes(app, deps);
  credentialRoutes(app, deps.db, deps.vault, deps.github, deps, deps.publicUrl);

  return app;
}
