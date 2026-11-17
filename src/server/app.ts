import { Hono } from "hono";
import { cors } from "hono/cors";
import { schemaVersion, type Db } from "./db.js";
import { authRoutes, type AuthDeps, type Env } from "./auth.js";
import { credentialRoutes, type GitHubOAuth, type Vault } from "./credentials.js";
import { projectRoutes } from "./projects.js";
import { workerRoutes, type SendPush } from "./workers.js";
import { githubSignInRoutes, type GitHubDevice } from "./github-signin.js";
import { publisher } from "./publish.js";
import { passkeys, type PasskeyConfig } from "./passkeys.js";
import { vercel, type VercelApi } from "./vercel.js";
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
  /** Setups still running after their request returned; shutdown waits for them. */
  setups?: Set<Promise<unknown>>;
  /** Origins the web build is served from; only they may call across origins. */
  webOrigins?: string[];
  /** Vercel, for putting web projects online; the real API unless a test says otherwise. */
  vercel?: VercelApi;
  /** How long a publish waits between looks at a deployment; tests shorten it. */
  publishPollMs?: number;
  /** The passkeys' domain and pages; sfo.dannyyoustra.com unless a test says otherwise. */
  passkeys?: PasskeyConfig;
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
  const keys = passkeys(deps.db, { apple: deps.allowed, github: deps.allowedGithub }, deps.passkeys);
  authRoutes(app, { ...deps, passkeySignIn: keys.verifySignIn, passkeyDomain: keys.domain });
  keys.routes(app);
  githubSignInRoutes(app, { db: deps.db, github: deps.githubDevice, allowlists: { apple: deps.allowed, github: deps.allowedGithub }, holdMs: deps.holdMs, log: deps.log });
  const setups = deps.setups ?? new Set<Promise<unknown>>();
  const publishing = publisher({ db: deps.db, vault: deps.vault, sprites: deps.sprites, vercel: deps.vercel ?? vercel, inflight: setups, log: deps.log, pollMs: deps.publishPollMs });
  credentialRoutes(app, deps.db, deps.vault, deps.github, deps.githubRedirects, deps.vercel ?? vercel);
  projectRoutes(app, { db: deps.db, vault: deps.vault, sprites: deps.sprites, repos: deps.repos, oauth: deps.github, controlUrl: deps.publicUrl, setups, publisher: publishing });
  workerRoutes(app, { db: deps.db, sprites: deps.sprites, push: deps.push ?? (async () => {}), log: deps.log, publisher: publishing });

  return app;
}
