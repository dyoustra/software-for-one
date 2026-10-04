import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import type { Db } from "./db.js";
import { requireDevice, type Env } from "./auth.js";

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

  /** A short-lived, unforgeable stand-in for who started a browser flow. */
  sign(userId: string, ttlMs: number): string {
    const payload = `${userId}.${Date.now() + ttlMs}`;
    return `${Buffer.from(payload).toString("base64url")}.${this.mac(payload)}`;
  }

  verify(state: string): string | null {
    const [encoded, mac] = state.split(".");
    if (!encoded || !mac) return null;
    const payload = Buffer.from(encoded, "base64url").toString("utf8");
    const expected = Buffer.from(this.mac(payload));
    if (expected.length !== Buffer.from(mac).length || !timingSafeEqual(expected, Buffer.from(mac))) return null;
    const [userId, expires] = payload.split(".");
    return Number(expires) > Date.now() ? userId : null;
  }

  private mac(payload: string): string {
    return createHmac("sha256", this.key).update(`state|${payload}`).digest("base64url");
  }
}

/** GitHub's side of connecting an account, injectable for tests. */
export interface GitHubOAuth {
  authorizeUrl(state: string): string;
  /** Exchanges a callback code or a refresh token for fresh tokens. */
  exchange(grant: { code: string } | { refreshToken: string }): Promise<GitHubTokens>;
}

export interface GitHubTokens {
  accessToken: string;
  refreshToken: string | null;
  /** ISO time the access token stops working, or null if it does not expire. */
  expiresAt: string | null;
}

export function githubOAuth(clientId: string, clientSecret: string, callbackUrl: string): GitHubOAuth {
  return {
    authorizeUrl: (state) =>
      `https://github.com/login/oauth/authorize?${new URLSearchParams({ client_id: clientId, redirect_uri: callbackUrl, state })}`,
    async exchange(grant) {
      const body =
        "code" in grant
          ? { client_id: clientId, client_secret: clientSecret, code: grant.code, redirect_uri: callbackUrl }
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

export function credentialRoutes(app: Hono<Env>, db: Db, vault: Vault, gh: GitHubOAuth): void {
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

  // The app or CLI asks for a link to open; GitHub sends the person back to
  // /github/callback, and the signed state says who started it.
  app.post("/github/connect", auth, (c: Context<Env>) => c.json({ url: gh.authorizeUrl(vault.sign(c.get("userId"), 10 * 60_000)) }));

  app.get("/github/callback", async (c) => {
    const userId = vault.verify(c.req.query("state") ?? "");
    const code = c.req.query("code");
    if (!userId || !code) return c.html(page("This link has expired. Start again from sfo."), 400);
    try {
      vault.put(userId, "github_installation", JSON.stringify(await gh.exchange({ code })));
    } catch (err) {
      return c.html(page(`GitHub did not connect: ${err instanceof Error ? err.message : String(err)}`), 502);
    }
    return c.html(page("GitHub is connected. You can close this page."));
  });
}

function page(message: string): string {
  const safe = message.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] ?? ch);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>sfo</title>
<style>body{font:16px -apple-system,system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;color:#111;background:#fff}@media (prefers-color-scheme:dark){body{color:#eee;background:#111}}</style>
</head><body><p>${safe}</p></body></html>`;
}
