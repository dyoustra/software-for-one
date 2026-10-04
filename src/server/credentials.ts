import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Context, Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { Db } from "./db.js";
import { hashToken, personFor, requireDevice, type AuthDeps, type Env } from "./auth.js";

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

export function credentialRoutes(
  app: Hono<Env>,
  db: Db,
  vault: Vault,
  gh: GitHubOAuth,
  identity: Pick<AuthDeps, "db" | "verifyApple" | "allowed" | "log">,
  publicUrl: string,
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

  // Connecting GitHub is started by a signed-in device and finished in a
  // browser, and the browser must prove it is the same person: a link someone
  // else started, sent to you, would otherwise link your GitHub account to
  // theirs. So the browser signs in with Apple (and must match), gets a cookie
  // for this flow, and GitHub's return must carry both; each flow works once.
  const FLOW_COOKIE = "sfo_github_flow";
  const flowFor = (flow: string) =>
    db.prepare("SELECT user_id, expires_at, used_at FROM github_flows WHERE flow_hash = ?").get(hashToken(flow)) as
      | { user_id: string; expires_at: string; used_at: string | null }
      | undefined;
  const live = (row: ReturnType<typeof flowFor>): row is NonNullable<ReturnType<typeof flowFor>> =>
    !!row && !row.used_at && row.expires_at > new Date().toISOString();

  app.post("/github/connect", auth, (c: Context<Env>) => {
    const flow = randomBytes(32).toString("base64url");
    db.prepare("INSERT INTO github_flows (flow_hash, user_id, expires_at) VALUES (?, ?, ?)").run(
      hashToken(flow),
      c.get("userId"),
      new Date(Date.now() + 10 * 60_000).toISOString(),
    );
    return c.json({ url: `${publicUrl}/github/start?flow=${flow}` });
  });

  app.get("/github/start", (c) => c.html(startPage()));

  app.post("/github/start", async (c) => {
    const { flow, idToken } = (await c.req.json().catch(() => ({}))) as { flow?: string; idToken?: string };
    const row = flowFor(flow ?? "");
    if (!flow || !live(row)) return c.json({ error: "this link has expired or was used — start again from sfo" }, 400);
    const userId = idToken ? await personFor(identity, idToken).catch(() => null) : null;
    if (userId !== row.user_id) return c.json({ error: "this link was started by a different sfo account — start it from your own" }, 403);
    setCookie(c, FLOW_COOKIE, flow, { httpOnly: true, secure: true, sameSite: "Lax", path: "/github", maxAge: 600 });
    return c.json({ redirect: gh.authorizeUrl(flow) });
  });

  app.get("/github/callback", async (c) => {
    const flow = c.req.query("state") ?? "";
    const code = c.req.query("code");
    const row = flowFor(flow);
    if (!code || !live(row) || getCookie(c, FLOW_COOKIE) !== flow) {
      return c.html(page("This GitHub link was not started in this browser, or has expired. Start again from sfo."), 400);
    }
    db.prepare("UPDATE github_flows SET used_at = ? WHERE flow_hash = ?").run(new Date().toISOString(), hashToken(flow));
    try {
      vault.put(row.user_id, "github_installation", JSON.stringify(await gh.exchange({ code })));
    } catch (err) {
      return c.html(page(`GitHub did not connect: ${err instanceof Error ? err.message : String(err)}`), 502);
    }
    return c.html(page("GitHub is connected. You can close this page."));
  });
}

function startPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>sfo — connect GitHub</title>
<style>body{font:16px -apple-system,system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;color:#111;background:#fff}@media (prefers-color-scheme:dark){body{color:#eee;background:#111}}button{font:inherit;padding:.6rem 1rem}</style>
<script src="https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js"></script></head>
<body><h1>Connect GitHub</h1><p>Sign in with the Apple account you use for sfo, then approve sfo on GitHub.</p>
<p><button id="go">Sign in with Apple and continue</button></p><p id="msg"></p>
<script>
AppleID.auth.init({clientId:"com.youstra.sfo.web",scope:"",redirectURI:location.origin+"/approve",usePopup:true});
document.getElementById("go").onclick=async()=>{
  const msg=document.getElementById("msg");
  try{
    const r=await AppleID.auth.signIn();
    const res=await fetch("/github/start",{method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({flow:new URLSearchParams(location.search).get("flow"),idToken:r.authorization.id_token})});
    const body=await res.json();
    if(res.ok) location.href=body.redirect; else msg.textContent=body.error;
  }catch(e){msg.textContent="Sign-in did not finish: "+(e.error||e.message||e);}
};
</script></body></html>`;
}

function page(message: string): string {
  const safe = message.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] ?? ch);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>sfo</title>
<style>body{font:16px -apple-system,system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;color:#111;background:#fff}@media (prefers-color-scheme:dark){body{color:#eee;background:#111}}</style>
</head><body><p>${safe}</p></body></html>`;
}
