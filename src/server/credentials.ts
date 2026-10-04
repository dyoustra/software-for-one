import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Context, Hono } from "hono";
import type { Db } from "./db.js";
import { hashToken, requireDevice, type Env } from "./auth.js";

export const KINDS = ["claude_token", "anthropic_api_key", "github_installation"] as const;
export type CredentialKind = (typeof KINDS)[number];

/**
 * A person's credentials, encrypted with AES-256-GCM under a key that lives
 * only in the server's environment: a copy of the database alone opens nothing.
 */
export class Vault {
  private readonly key: Buffer;

  constructor(
    private readonly db: Db,
    base64Key: string,
  ) {
    this.key = Buffer.from(base64Key, "base64");
    if (this.key.length !== 32) throw new Error("SFO_CREDENTIALS_KEY must be 32 bytes, base64");
  }

  put(userId: string, kind: CredentialKind, value: string): void {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    const sealed = Buffer.concat([cipher.update(value, "utf8"), cipher.final(), cipher.getAuthTag()]);
    this.db
      .prepare(
        "INSERT INTO credentials (user_id, kind, ciphertext, nonce, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (user_id, kind) DO UPDATE SET ciphertext = excluded.ciphertext, nonce = excluded.nonce, created_at = excluded.created_at",
      )
      .run(userId, kind, sealed, nonce, new Date().toISOString());
  }

  get(userId: string, kind: CredentialKind): string | null {
    const row = this.db.prepare("SELECT ciphertext, nonce FROM credentials WHERE user_id = ? AND kind = ?").get(userId, kind) as
      | { ciphertext: Uint8Array; nonce: Uint8Array }
      | undefined;
    if (!row) return null;
    const sealed = Buffer.from(row.ciphertext);
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(row.nonce));
    decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]).toString("utf8");
  }

  kinds(userId: string): CredentialKind[] {
    return (this.db.prepare("SELECT kind FROM credentials WHERE user_id = ? ORDER BY kind").all(userId) as { kind: CredentialKind }[]).map((r) => r.kind);
  }

  remove(userId: string, kind: CredentialKind): boolean {
    return this.db.prepare("DELETE FROM credentials WHERE user_id = ? AND kind = ?").run(userId, kind).changes > 0;
  }
}

/** GitHub's side of connecting an account, injectable for tests. */
export interface GitHubOAuth {
  clientId: string;
  authorizeUrl(state: string, redirectUri: string): string;
  /** Exchanges a returned code or a refresh token for fresh tokens. */
  exchange(grant: { code: string; redirectUri: string } | { refreshToken: string }): Promise<GitHubTokens>;
  /** Whose account a token is for; throws if GitHub does not accept it. */
  whoami(accessToken: string): Promise<string>;
}

export interface GitHubTokens {
  accessToken: string;
  refreshToken: string | null;
  /** ISO time the access token stops working, or null if it does not expire. */
  expiresAt: string | null;
}

export function githubOAuth(clientId: string, clientSecret: string): GitHubOAuth {
  return {
    clientId,
    authorizeUrl: (state, redirectUri) =>
      `https://github.com/login/oauth/authorize?${new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, state })}`,
    async exchange(grant) {
      const body =
        "code" in grant
          ? { client_id: clientId, client_secret: clientSecret, code: grant.code, redirect_uri: grant.redirectUri }
          : { client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token", refresh_token: grant.refreshToken };
      const res = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; error_description?: string };
      if (!json.access_token) throw new Error(`GitHub refused: ${json.error_description ?? res.status}`);
      return {
        accessToken: json.access_token,
        refreshToken: json.refresh_token ?? null,
        expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000).toISOString() : null,
      };
    },
    async whoami(accessToken) {
      const res = await fetch("https://api.github.com/user", { headers: { authorization: `Bearer ${accessToken}`, accept: "application/vnd.github+json" } });
      if (!res.ok) throw new Error(`GitHub did not accept the token (${res.status})`);
      return ((await res.json()) as { login: string }).login;
    },
  };
}

/** The person's GitHub token, refreshed first if it is about to expire. Null if they never connected. */
export async function githubToken(vault: Vault, gh: GitHubOAuth, userId: string): Promise<string | null> {
  const stored = vault.get(userId, "github_installation");
  if (!stored) return null;
  const tokens = JSON.parse(stored) as GitHubTokens;
  const soon = Date.now() + 5 * 60_000;
  if (!tokens.expiresAt || new Date(tokens.expiresAt).getTime() > soon || !tokens.refreshToken) return tokens.accessToken;
  const fresh = await gh.exchange({ refreshToken: tokens.refreshToken });
  vault.put(userId, "github_installation", JSON.stringify(fresh));
  return fresh.accessToken;
}

export function credentialRoutes(
  app: Hono<Env>,
  db: Db,
  vault: Vault,
  gh: GitHubOAuth,
  /** Where GitHub may send someone back: the app's own addresses, as registered on the GitHub App. */
  redirects: string[],
): void {
  const auth = requireDevice(db);

  app.get("/credentials", auth, (c: Context<Env>) => c.json({ have: vault.kinds(c.get("userId")) }));

  for (const [path, kind, pattern] of [
    ["claude", "claude_token", /^sk-ant-oat/],
    ["api-key", "anthropic_api_key", /^sk-ant-api/],
  ] as const) {
    app.put(`/credentials/${path}`, auth, async (c: Context<Env>) => {
      const { value } = (await c.req.json().catch(() => ({}))) as { value?: string };
      if (!value || !pattern.test(value.trim())) return c.json({ error: `that does not look like ${kind === "claude_token" ? "a `claude setup-token` token" : "an Anthropic API key"}` }, 400);
      vault.put(c.get("userId"), kind, value.trim());
      return c.json({ ok: true });
    });
  }

  app.delete("/credentials/:kind", auth, (c: Context<Env>) => {
    const kind = KINDS.find((k) => k === c.req.param("kind"));
    if (!kind) return c.json({ error: `one of: ${KINDS.join(", ")}` }, 400);
    return vault.remove(c.get("userId"), kind) ? c.json({ ok: true }) : c.json({ error: "nothing stored" }, 404);
  });

  // Whichever signed-in client starts a GitHub connection finishes it, over
  // its own session: the app opens GitHub inside itself, GitHub returns to the
  // app, and the app hands the code back here. The flow must belong to the
  // person finishing it, so a link someone else started, landing in your app,
  // is refused rather than linking your GitHub to their account. Single-use.
  const flowFor = (flow: string) =>
    db.prepare("SELECT user_id, expires_at, used_at FROM github_flows WHERE flow_hash = ?").get(hashToken(flow)) as
      | { user_id: string; expires_at: string; used_at: string | null }
      | undefined;

  app.get("/github/app", (c) => c.json({ clientId: gh.clientId }));

  app.post("/github/connect", auth, async (c: Context<Env>) => {
    const { redirectUri } = (await c.req.json().catch(() => ({}))) as { redirectUri?: string };
    if (!redirectUri || !redirects.includes(redirectUri)) return c.json({ error: `redirectUri must be one of: ${redirects.join(", ")}` }, 400);
    const flow = randomBytes(32).toString("base64url");
    db.prepare("INSERT INTO github_flows (flow_hash, user_id, expires_at) VALUES (?, ?, ?)").run(
      hashToken(flow),
      c.get("userId"),
      new Date(Date.now() + 10 * 60_000).toISOString(),
    );
    return c.json({ url: gh.authorizeUrl(flow, redirectUri) });
  });

  app.post("/github/complete", auth, async (c: Context<Env>) => {
    const { code, state, redirectUri } = (await c.req.json().catch(() => ({}))) as { code?: string; state?: string; redirectUri?: string };
    const row = flowFor(state ?? "");
    if (!code || !redirectUri || !row || row.used_at || row.expires_at < new Date().toISOString()) {
      return c.json({ error: "this GitHub connection has expired or was used — start again" }, 400);
    }
    if (row.user_id !== c.get("userId")) return c.json({ error: "this GitHub connection was started by a different sfo account" }, 403);
    db.prepare("UPDATE github_flows SET used_at = ? WHERE flow_hash = ?").run(new Date().toISOString(), hashToken(state ?? ""));
    try {
      vault.put(row.user_id, "github_installation", JSON.stringify(await gh.exchange({ code, redirectUri })));
    } catch (err) {
      return c.json({ error: `GitHub did not connect: ${err instanceof Error ? err.message : String(err)}` }, 502);
    }
    return c.json({ ok: true });
  });

  // The CLI runs GitHub's device flow itself and brings the tokens here; they
  // are kept only once GitHub confirms they work.
  app.put("/credentials/github", auth, async (c: Context<Env>) => {
    const tokens = (await c.req.json().catch(() => ({}))) as Partial<GitHubTokens>;
    if (typeof tokens.accessToken !== "string") return c.json({ error: "accessToken is required" }, 400);
    const login = await gh.whoami(tokens.accessToken).catch(() => null);
    if (!login) return c.json({ error: "GitHub did not accept that token" }, 400);
    vault.put(c.get("userId"), "github_installation", JSON.stringify({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken ?? null, expiresAt: tokens.expiresAt ?? null }));
    return c.json({ ok: true, login });
  });
}

