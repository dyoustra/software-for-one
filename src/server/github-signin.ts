import { randomBytes } from "node:crypto";
import type { Context, Hono } from "hono";
import type { Db } from "./db.js";
import { accountFor, hashToken, issueDevice, type Allowlists, type Env } from "./auth.js";

/** GitHub's device flow, as this server drives it; injectable for tests. */
export interface GitHubDevice {
  start(): Promise<{ deviceCode: string; userCode: string; verificationUri: string; intervalS: number; expiresInS: number }>;
  /** One poll: the token, or why not yet. */
  poll(deviceCode: string): Promise<{ token: string } | { pending: true; slowDown?: number } | { error: string }>;
  /** GitHub's numeric id for the account a token belongs to. */
  userId(token: string): Promise<string>;
}

export function githubDevice(clientId: string): GitHubDevice {
  const post = async (url: string, body: Record<string, string>) =>
    (await (await fetch(url, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body) })).json()) as Record<string, unknown>;
  return {
    async start() {
      const r = await post("https://github.com/login/device/code", { client_id: clientId });
      if (typeof r.device_code !== "string") throw new Error(`GitHub would not start a sign-in: ${String(r.error_description ?? r.error ?? "unknown")}`);
      return {
        deviceCode: r.device_code,
        userCode: String(r.user_code),
        verificationUri: String(r.verification_uri),
        intervalS: Number(r.interval ?? 5),
        expiresInS: Number(r.expires_in ?? 900),
      };
    },
    async poll(deviceCode) {
      const r = await post("https://github.com/login/oauth/access_token", { client_id: clientId, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
      if (typeof r.access_token === "string") return { token: r.access_token };
      if (r.error === "authorization_pending") return { pending: true };
      if (r.error === "slow_down") return { pending: true, slowDown: typeof r.interval === "number" ? r.interval : undefined };
      return { error: r.error === "access_denied" ? "declined on GitHub" : String(r.error_description ?? r.error ?? "GitHub sign-in failed") };
    },
    async userId(token) {
      const res = await fetch("https://api.github.com/user", { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" } });
      if (!res.ok) throw new Error(`GitHub did not accept the token (${res.status})`);
      return String(((await res.json()) as { id: number }).id);
    },
  };
}

type Flow = { deviceCode: string; intervalMs: number; expires: number; nextPollAt: number };

/**
 * Sign in with GitHub, for every client: GitHub's device flow, run here,
 * because GitHub's device endpoints refuse browsers. The client shows the
 * code and waits on a request this server holds while it polls GitHub at
 * GitHub's pace. The token comes to this server from our own client id, so no
 * client ever hands one over to be trusted; it is used once, to learn who,
 * and dropped.
 */
export function githubSignInRoutes(
  app: Hono<Env>,
  deps: { db: Db; github: GitHubDevice; allowlists: Allowlists; holdMs?: number; log?: (m: string) => void },
): void {
  const { db, github } = deps;
  const holdMs = deps.holdMs ?? 50_000;
  // Kept in memory: a flow lives minutes, and one lost to a restart is
  // started again by the person.
  const flows = new Map<string, Flow>();

  app.post("/auth/github/start", async (c) => {
    for (const [k, f] of flows) if (f.expires < Date.now()) flows.delete(k);
    const started = await github.start();
    const flow = randomBytes(24).toString("base64url");
    flows.set(hashToken(flow), {
      deviceCode: started.deviceCode,
      intervalMs: started.intervalS * 1000,
      expires: Date.now() + started.expiresInS * 1000,
      nextPollAt: Date.now() + started.intervalS * 1000,
    });
    return c.json({ flow, userCode: started.userCode, verificationUri: started.verificationUri });
  });

  // Signed in (a device token) and `link: true` adds this GitHub account to
  // that account; otherwise it signs in.
  app.post("/auth/github/wait", async (c: Context<Env>) => {
    const body = (await c.req.json().catch(() => ({}))) as { flow?: string; deviceName?: string; link?: boolean };
    const key = hashToken(body.flow ?? "");
    const deadline = Date.now() + holdMs;
    for (;;) {
      const f = flows.get(key);
      if (!f || f.expires < Date.now()) return c.json({ error: "this sign-in expired — start again" }, 410);
      if (Date.now() >= f.nextPollAt) {
        const r = await github.poll(f.deviceCode);
        if ("error" in r) {
          flows.delete(key);
          return c.json({ error: r.error }, 403);
        }
        if ("token" in r) {
          flows.delete(key);
          return finish(c, await github.userId(r.token), body);
        }
        if (r.slowDown) f.intervalMs = r.slowDown * 1000;
        else if ("slowDown" in r) f.intervalMs += 5000;
        f.nextPollAt = Date.now() + f.intervalMs;
      }
      if (Date.now() >= deadline) return c.json({ status: "pending" }, 202);
      await new Promise((r) => setTimeout(r, Math.min(500, Math.max(0, f.nextPollAt - Date.now()))));
    }
  });

  function finish(c: Context<Env>, githubId: string, body: { deviceName?: string; link?: boolean }) {
    if (body.link) {
      const token = c.req.header("authorization")?.match(/^Bearer (.+)$/)?.[1];
      const device = token
        ? (db.prepare("SELECT user_id FROM devices WHERE token_hash = ? AND revoked_at IS NULL").get(hashToken(token)) as { user_id: string } | undefined)
        : undefined;
      if (!device) return c.json({ error: "sign in first to add GitHub to your account" }, 401);
      const owner = db.prepare("SELECT user_id FROM identities WHERE provider = 'github' AND subject = ?").get(githubId) as { user_id: string } | undefined;
      if (owner && owner.user_id !== device.user_id) return c.json({ error: "that GitHub account already signs in to another sfo account" }, 409);
      if (!owner) db.prepare("INSERT INTO identities (user_id, provider, subject, created_at) VALUES (?, 'github', ?, ?)").run(device.user_id, githubId, new Date().toISOString());
      return c.json({ ok: true, linked: "github" });
    }
    const userId = accountFor(db, "github", githubId, deps.allowlists, deps.log);
    if (!userId) return c.json({ error: "this GitHub account is not allowed in" }, 403);
    return c.json({ token: issueDevice(db, userId, (body.deviceName || "a device").slice(0, 80)).token });
  }
}
