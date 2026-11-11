import { Hono } from "hono";
import { cors } from "hono/cors";
import { schemaVersion, type Db } from "./db.js";
import { authRoutes, type AuthDeps, type Env } from "./auth.js";
import { credentialRoutes, type GitHubOAuth, type Vault } from "./credentials.js";
import { projectRoutes } from "./projects.js";
import { workerRoutes, type SendPush } from "./workers.js";
import { githubSignInRoutes, type GitHubDevice } from "./github-signin.js";
import type { SpriteCli } from "../core/sprite.js";
import type { GitHub } from "../core/provision.js";

export interface ServerDeps extends Omit<AuthDeps, "db"> {
  db: Db;
  /** The commit this build came from, so a health check says what is running. */
  version: string;
  vault: Vault;
  github: GitHubOAuth;
  githubRedirects: string[];
  sprites: SpriteCli;
  repos?: GitHub;
  push?: SendPush;
  githubDevice: GitHubDevice;
  /** GitHub accounts (numeric ids) allowed to sign in. */
  allowedGithub: Set<string>;
  /** Origins the web build is served from; only they may call across origins. */
  webOrigins?: string[];
}

/**
 * The control plane's HTTP API. Every action finishes inside its request: the
 * Machine stops when idle, and Fly never stops one with a request in flight.
 */
export function createApp(deps: ServerDeps): Hono<Env> {
  const app = new Hono<Env>();
  const origins = deps.webOrigins ?? ["http://localhost:8081"];
  app.use("*", cors({ origin: (origin) => (origins.includes(origin) ? origin : null), allowHeaders: ["authorization", "content-type"], maxAge: 600 }));

  app.get("/health", (c) => c.json({ ok: true, version: deps.version, schema: schemaVersion(deps.db) }));
  authRoutes(app, deps);
  githubSignInRoutes(app, { db: deps.db, github: deps.githubDevice, allowed: deps.allowedGithub, holdMs: deps.holdMs, log: deps.log });
  credentialRoutes(app, deps.db, deps.vault, deps.github, deps.githubRedirects);
  projectRoutes(app, { db: deps.db, vault: deps.vault, sprites: deps.sprites, repos: deps.repos, oauth: deps.github, controlUrl: deps.publicUrl });
  workerRoutes(app, { db: deps.db, sprites: deps.sprites, push: deps.push ?? (async () => {}), log: deps.log });

  return app;
}
