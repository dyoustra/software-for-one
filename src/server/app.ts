import { Hono } from "hono";
import { schemaVersion, type Db } from "./db.js";

export interface ServerDeps {
  db: Db;
  /** The commit this build came from, so a health check says what is running. */
  version: string;
}

/**
 * The control plane's HTTP API. Every action finishes inside its request: the
 * Machine stops when idle, and Fly never stops one with a request in flight.
 */
export function createApp(deps: ServerDeps): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true, version: deps.version, schema: schemaVersion(deps.db) }));

  return app;
}
