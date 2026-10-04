import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Context, Hono, MiddlewareHandler } from "hono";
import type { Db } from "./db.js";
import type { VerifyApple } from "./apple.js";

export interface AuthDeps {
  db: Db;
  verifyApple: VerifyApple;
  /** Apple ids allowed in. Everyone else is refused, and their id logged so it can be added. */
  allowed: Set<string>;
  /** Where the approval page is, as the CLI should be told. */
  publicUrl: string;
  /** How long a device-code request is held open before the CLI asks again. */
  holdMs?: number;
  log?: (message: string) => void;
}

export type Env = { Variables: { userId: string; deviceId: string } };

const DEVICE_CODE_TTL_MS = 10 * 60_000;
/** No 0/O or 1/I: a code is read off one screen and typed or checked on another. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const now = (): string => new Date().toISOString();
export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");


function userCode(): string {
  const bytes = randomBytes(8);
  const chars = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

/** The person behind an Apple sign-in, created on first sight, or null if they are not allowed in. */
async function personFor(deps: AuthDeps, idToken: string): Promise<string | null> {
  const who = await deps.verifyApple(idToken);
  if (!deps.allowed.has(who.sub)) {
    // Apple's opaque id only: it is what the allowlist needs, and names no one.
    (deps.log ?? console.log)(`sign-in refused for Apple id ${who.sub} — to allow it: fly secrets set SFO_ALLOWED_APPLE_IDS=${who.sub}`);
    return null;
  }
  const found = deps.db.prepare("SELECT id FROM users WHERE apple_sub = ?").get(who.sub) as { id: string } | undefined;
  if (found) return found.id;
  const id = randomUUID();
  deps.db.prepare("INSERT INTO users (id, apple_sub, created_at) VALUES (?, ?, ?)").run(id, who.sub, now());
  return id;
}

/** A new signed-in device for this person, and the token it uses; only the token's hash is kept. */
function issueDevice(db: Db, userId: string, name: string): { deviceId: string; token: string } {
  const token = `sfo_${randomBytes(32).toString("base64url")}`;
  const deviceId = randomUUID();
  db.prepare("INSERT INTO devices (id, user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(deviceId, userId, name, hashToken(token), now());
  return { deviceId, token };
}

/** Lets a request through with a live device token, and says whose. */
export function requireDevice(db: Db): MiddlewareHandler<Env> {
  return async (c, next) => {
    const token = c.req.header("authorization")?.match(/^Bearer (.+)$/)?.[1];
    const device = token
      ? (db.prepare("SELECT id, user_id FROM devices WHERE token_hash = ? AND revoked_at IS NULL").get(hashToken(token)) as { id: string; user_id: string } | undefined)
      : undefined;
    if (!device) return c.json({ error: "sign in first: `sfo login`" }, 401);
    db.prepare("UPDATE devices SET last_used_at = ? WHERE id = ?").run(now(), device.id);
    c.set("userId", device.user_id);
    c.set("deviceId", device.id);
    await next();
  };
}

type CodeRow = { device_code: string; user_code: string; device_name: string; status: string; user_id: string | null; expires_at: string };

export function authRoutes(app: Hono<Env>, deps: AuthDeps): void {
  const { db } = deps;
  const holdMs = deps.holdMs ?? 50_000;

  app.post("/auth/apple", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { idToken?: string; deviceName?: string };
    if (!body.idToken) return c.json({ error: "idToken is required" }, 400);
    const userId = await personFor(deps, body.idToken).catch(() => null);
    if (!userId) return c.json({ error: "this Apple account is not allowed in" }, 403);
    return c.json({ token: issueDevice(db, userId, body.deviceName || "app").token });
  });

  app.post("/auth/device", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { name?: string };
    const deviceCode = randomBytes(32).toString("base64url");
    const code = userCode();
    db.prepare("INSERT INTO device_codes (device_code, user_code, device_name, expires_at) VALUES (?, ?, ?, ?)").run(
      hashToken(deviceCode),
      code,
      (body.name || "a device").slice(0, 80),
      new Date(Date.now() + DEVICE_CODE_TTL_MS).toISOString(),
    );
    return c.json({ deviceCode, userCode: code, verifyUrl: `${deps.publicUrl}/approve` });
  });

  // Held open until approved, denied or expired, up to holdMs; the CLI asks again
  // on 202. The wait is inside the request, so the Machine is not stopped under it.
  app.get("/auth/device/:deviceCode", async (c) => {
    const deadline = Date.now() + holdMs;
    const deviceCode = c.req.param("deviceCode") ?? "";
    for (;;) {
      const row = db.prepare("SELECT * FROM device_codes WHERE device_code = ?").get(hashToken(deviceCode)) as CodeRow | undefined;
      if (!row || row.expires_at < now()) return c.json({ error: "this code has expired — `sfo login` again" }, 410);
      if (row.status === "denied") {
        db.prepare("DELETE FROM device_codes WHERE device_code = ?").run(row.device_code);
        return c.json({ error: "denied" }, 403);
      }
      // The token is made here, for the CLI holding the code, and never stored
      // waiting: the database keeps only the code's hash and, after this, the
      // token's.
      if (row.status === "approved" && row.user_id) {
        db.prepare("DELETE FROM device_codes WHERE device_code = ?").run(row.device_code);
        return c.json({ token: issueDevice(db, row.user_id, row.device_name).token });
      }
      if (Date.now() >= deadline) return c.json({ status: "pending" }, 202);
      await new Promise((r) => setTimeout(r, 500));
    }
  });

  app.get("/approve", (c) => c.html(approvePage()));

  app.post("/approve", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { userCode?: string; idToken?: string; approve?: boolean };
    const row = db.prepare("SELECT * FROM device_codes WHERE user_code = ?").get((body.userCode ?? "").toUpperCase().trim()) as CodeRow | undefined;
    if (!row || row.expires_at < now() || row.status !== "pending") return c.json({ error: "no such code waiting — check it, or `sfo login` again" }, 404);
    const userId = body.idToken ? await personFor(deps, body.idToken).catch(() => null) : null;
    if (!userId) return c.json({ error: "this Apple account is not allowed in" }, 403);
    if (!body.approve) {
      db.prepare("UPDATE device_codes SET status = 'denied' WHERE device_code = ?").run(row.device_code);
      return c.json({ ok: true, approved: false });
    }
    db.prepare("UPDATE device_codes SET status = 'approved', user_id = ? WHERE device_code = ?").run(userId, row.device_code);
    return c.json({ ok: true, approved: true, device: row.device_name });
  });

  app.get("/devices", requireDevice(db), (c: Context<Env>) =>
    c.json(
      db
        .prepare("SELECT id, name, created_at AS createdAt, last_used_at AS lastUsedAt FROM devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at")
        .all(c.get("userId")),
    ),
  );

  app.delete("/devices/current", requireDevice(db), (c: Context<Env>) => {
    db.prepare("UPDATE devices SET revoked_at = ? WHERE id = ?").run(now(), c.get("deviceId"));
    return c.json({ ok: true });
  });

  app.delete("/devices/:id", requireDevice(db), (c: Context<Env>) => {
    const r = db.prepare("UPDATE devices SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL").run(now(), c.req.param("id") ?? "", c.get("userId"));
    return r.changes ? c.json({ ok: true }) : c.json({ error: "no such device" }, 404);
  });
}

/** One page: sign in with Apple, then approve or deny the code a device is showing. */
/**
 * The code is typed, never filled in from the link: a pre-filled code is how
 * someone else's sign-in, sent as a link, gets approved in one click.
 */
function approvePage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>sfo — approve a device</title>
<style>body{font:16px -apple-system,system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;color:#111;background:#fff}
@media (prefers-color-scheme:dark){body{color:#eee;background:#111}}input{font:inherit;font-size:1.4rem;letter-spacing:.15em;padding:.4rem;width:10ch;text-transform:uppercase}
button{font:inherit;padding:.6rem 1rem;margin:.4rem .4rem 0 0}#msg{margin-top:1rem}</style>
<script src="https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js"></script></head>
<body><h1>Approve a device</h1>
<p><strong>Only approve a code your own terminal is showing you right now.</strong>
Approving signs that device in as you; never approve a code someone sent you.</p>
<p>Type the code from your terminal:</p>
<p><input id="code" value="" placeholder="XXXX-XXXX" maxlength="9" autocomplete="off"></p>
<p><button id="yes">Sign in with Apple and approve</button><button id="no">Deny</button></p>
<p id="msg"></p>
<script>
AppleID.auth.init({clientId:"com.youstra.sfo.web",scope:"",redirectURI:location.origin+"/approve",usePopup:true});
async function decide(approve){
  const msg=document.getElementById("msg");
  try{
    const r=await AppleID.auth.signIn();
    const res=await fetch("/approve",{method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({userCode:document.getElementById("code").value,idToken:r.authorization.id_token,approve})});
    const body=await res.json();
    msg.textContent=res.ok?(body.approved?"Approved "+body.device+". You can close this page.":"Denied."):body.error;
  }catch(e){msg.textContent="Sign-in did not finish: "+(e.error||e.message||e);}
}
document.getElementById("yes").onclick=()=>decide(true);
document.getElementById("no").onclick=()=>decide(false);
</script></body></html>`;
}
