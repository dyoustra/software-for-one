import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Context, Hono, MiddlewareHandler } from "hono";
import type { Db } from "./db.js";
import type { VerifyApple } from "./apple.js";
import { clearSession, deliverToken, presentedToken, SESSION_DAYS, setSession, type SessionEnv } from "./session.js";

export interface AuthDeps {
  db: Db;
  verifyApple: VerifyApple;
  /** Apple ids allowed in. Everyone else is refused, and their id logged so it can be added. */
  allowed: Set<string>;
  /** GitHub accounts (numeric ids) allowed in, likewise. */
  allowedGithub: Set<string>;
  /** Where the approval page is, as the CLI should be told. */
  publicUrl: string;
  /** How long a device-code request is held open before the CLI asks again. */
  holdMs?: number;
  /** The domain passkeys are bound to: the approval page offers one only there. */
  passkeyDomain?: string;
  /** A passkey answer's account, for approving a code with a passkey instead of Apple. */
  passkeySignIn?: (challengeId: string, response: AuthenticationResponseJSON) => Promise<{ userId: string; passkeyId: string } | null>;
  log?: (message: string) => void;
}

export type Env = { Variables: { userId: string; deviceId: string } & SessionEnv["Variables"] };

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

export type Provider = "apple" | "github";

const PROVIDERS: Record<Provider, { name: string; allowlist: string }> = {
  apple: { name: "Apple", allowlist: "SFO_ALLOWED_APPLE_IDS" },
  github: { name: "GitHub", allowlist: "SFO_ALLOWED_GITHUB_IDS" },
};

export type Allowlists = Record<Provider, Set<string>>;

/**
 * The account a sign-in method belongs to, created on first sight for an
 * allowed identity, or null if it is not allowed in. An existing account gets
 * in while any of its methods is still allowlisted: a linked method needs no
 * entry of its own, and taking a person's ids off the allowlists locks them
 * out. A refused one is logged by its provider's opaque id (never a name or
 * email), which is what the allowlist needs.
 */
export function accountFor(db: Db, provider: Provider, subject: string, allowlists: Allowlists, log: (m: string) => void = console.log): string | null {
  const found = db.prepare("SELECT user_id FROM identities WHERE provider = ? AND subject = ?").get(provider, subject) as { user_id: string } | undefined;
  const permitted = found ? accountAllowed(db, found.user_id, allowlists) : allowlists[provider].has(subject);
  if (found && permitted) return found.user_id;
  if (!permitted) {
    log(`sign-in refused for ${PROVIDERS[provider].name} id ${subject} — to allow it: fly secrets set ${PROVIDERS[provider].allowlist}=${subject}`);
    return null;
  }
  const id = randomUUID();
  db.prepare("INSERT INTO users (id, created_at) VALUES (?, ?)").run(id, now());
  db.prepare("INSERT INTO identities (user_id, provider, subject, created_at) VALUES (?, ?, ?, ?)").run(id, provider, subject, now());
  return id;
}

/** Whether an account may sign in: while any of its methods with an outside identity is allowlisted. */
export function accountAllowed(db: Db, userId: string, allowlists: Allowlists): boolean {
  return (db.prepare("SELECT provider, subject FROM identities WHERE user_id = ?").all(userId) as { provider: Provider; subject: string }[]).some((i) =>
    allowlists[i.provider].has(i.subject),
  );
}

/** The person behind an Apple sign-in, or null if they are not allowed in. */
export async function personFor(deps: Pick<AuthDeps, "db" | "verifyApple" | "allowed" | "allowedGithub" | "log">, idToken: string): Promise<string | null> {
  const who = await deps.verifyApple(idToken);
  return accountFor(deps.db, "apple", who.sub, { apple: deps.allowed, github: deps.allowedGithub }, deps.log);
}

/** A new signed-in device for this person, and the token it uses; only the token's hash is kept. */
export function issueDevice(db: Db, userId: string, name: string): { deviceId: string; token: string } {
  const token = `sfo_${randomBytes(32).toString("base64url")}`;
  const deviceId = randomUUID();
  db.prepare("INSERT INTO devices (id, user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(deviceId, userId, name, hashToken(token), now());
  return { deviceId, token };
}

/**
 * A device signed in by a passkey, issued only if that passkey still exists
 * and the device that added it is live, in the same statement: a passkey
 * removed between its check and this cannot still let a device in.
 */
export function issueDeviceByPasskey(db: Db, userId: string, name: string, passkeyId: string): { deviceId: string; token: string } | null {
  const token = `sfo_${randomBytes(32).toString("base64url")}`;
  const deviceId = randomUUID();
  const r = db
    .prepare(
      "INSERT INTO devices (id, user_id, name, token_hash, created_at, passkey_id) SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM passkeys p LEFT JOIN devices d ON d.id = p.device_id WHERE p.id = ? AND (p.device_id IS NULL OR d.revoked_at IS NULL))",
    )
    .run(deviceId, userId, name, hashToken(token), now(), passkeyId, passkeyId);
  return r.changes ? { deviceId, token } : null;
}

/**
 * Revokes a device and everything it let in: the passkeys it added, the
 * devices those passkeys signed in, and so on down. A token that is stolen
 * and then revoked leaves nothing of its own behind.
 */
export function revokeDevice(db: Db, deviceId: string): void {
  const devices = [deviceId];
  while (devices.length > 0) {
    const d = devices.pop()!;
    db.prepare("UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now(), d);
    for (const { id } of db.prepare("SELECT id FROM passkeys WHERE device_id = ?").all(d) as { id: string }[]) devices.push(...removePasskeyOnly(db, id));
  }
}

/** Removes a passkey and revokes every device it signed in, and what they let in. */
export function removePasskey(db: Db, passkeyId: string): void {
  for (const d of removePasskeyOnly(db, passkeyId)) revokeDevice(db, d);
}

/** Deletes a passkey; answers the live devices it signed in, for the caller to revoke. */
function removePasskeyOnly(db: Db, passkeyId: string): string[] {
  db.prepare("DELETE FROM passkeys WHERE id = ?").run(passkeyId);
  // A CLI code it approved but the CLI has not collected yet goes too.
  db.prepare("UPDATE device_codes SET status = 'denied' WHERE passkey_id = ?").run(passkeyId);
  return (db.prepare("SELECT id FROM devices WHERE passkey_id = ? AND revoked_at IS NULL").all(passkeyId) as { id: string }[]).map((r) => r.id);
}

/**
 * The live device a request signs in as, by bearer token or session cookie,
 * or null. A cookie device answers only to its cookie and a bearer device
 * only to its header, so a token never moves from one to the other. A cookie
 * device unused for the cookie's lifetime is revoked, not merely refused.
 */
export function liveDevice(db: Db, c: Context): { id: string; user_id: string } | null {
  const presented = presentedToken(c);
  if (!presented) return null;
  const device = db.prepare("SELECT id, user_id, cookie, last_used_at FROM devices WHERE token_hash = ? AND revoked_at IS NULL").get(hashToken(presented.token)) as
    | { id: string; user_id: string; cookie: number; last_used_at: string | null }
    | undefined;
  if (!device || Boolean(device.cookie) !== presented.cookie) return null;
  if (device.cookie && device.last_used_at && Date.now() - Date.parse(device.last_used_at) > SESSION_DAYS * 86_400_000) {
    revokeDevice(db, device.id);
    return null;
  }
  db.prepare("UPDATE devices SET last_used_at = ? WHERE id = ?").run(now(), device.id);
  return device;
}

/** Lets a request through with a live device token, and says whose. */
export function requireDevice(db: Db): MiddlewareHandler<Env> {
  return async (c, next) => {
    const device = liveDevice(db, c);
    if (!device) {
      clearSession(c);
      return c.json({ error: "sign in first: `sfo login`" }, 401);
    }
    c.set("userId", device.user_id);
    c.set("deviceId", device.id);
    await next();
  };
}

type CodeRow = { device_code: string; user_code: string; device_name: string; status: string; user_id: string | null; passkey_id: string | null; expires_at: string };

export function authRoutes(app: Hono<Env>, deps: AuthDeps): void {
  const { db } = deps;
  const holdMs = deps.holdMs ?? 50_000;

  app.post("/auth/apple", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { idToken?: string; deviceName?: string };
    if (!body.idToken) return c.json({ error: "idToken is required" }, 400);
    const userId = await personFor(deps, body.idToken).catch(() => null);
    if (!userId) return c.json({ error: "this Apple account is not allowed in" }, 403);
    return deliverToken(c, db, issueDevice(db, userId, body.deviceName || "app"));
  });

  /** Whether the web app's cookie still signs it in; each answer slides the cookie's 30 days on. */
  app.get("/auth/session", requireDevice(db), (c: Context<Env>) => {
    const presented = presentedToken(c);
    if (presented?.cookie) setSession(c, presented.token);
    return c.json({ ok: true });
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
        const issued = row.passkey_id ? issueDeviceByPasskey(db, row.user_id, row.device_name, row.passkey_id) : issueDevice(db, row.user_id, row.device_name);
        if (!issued) return c.json({ error: "the passkey that approved this was removed — `sfo login` again" }, 403);
        return c.json({ token: issued.token });
      }
      if (Date.now() >= deadline) return c.json({ status: "pending" }, 202);
      await new Promise((r) => setTimeout(r, 500));
    }
  });

  app.get("/approve", (c) => c.html(approvePage(deps.passkeyDomain ?? null)));

  app.post("/approve", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { userCode?: string; idToken?: string; passkey?: { challengeId?: string; response?: AuthenticationResponseJSON }; approve?: boolean };
    const row = db.prepare("SELECT * FROM device_codes WHERE user_code = ?").get((body.userCode ?? "").toUpperCase().trim()) as CodeRow | undefined;
    if (!row || row.expires_at < now() || row.status !== "pending") return c.json({ error: "no such code waiting — check it, or `sfo login` again" }, 404);
    const byPasskey =
      !body.idToken && body.passkey?.challengeId && body.passkey.response && deps.passkeySignIn
        ? await deps.passkeySignIn(body.passkey.challengeId, body.passkey.response).catch(() => null)
        : null;
    const userId = body.idToken ? await personFor(deps, body.idToken).catch(() => null) : (byPasskey?.userId ?? null);
    if (!userId) return c.json({ error: body.passkey ? "that passkey did not sign in" : "this Apple account is not allowed in" }, 403);
    if (!body.approve) {
      db.prepare("UPDATE device_codes SET status = 'denied' WHERE device_code = ?").run(row.device_code);
      return c.json({ ok: true, approved: false });
    }
    db.prepare("UPDATE device_codes SET status = 'approved', user_id = ?, passkey_id = ? WHERE device_code = ?").run(userId, byPasskey?.passkeyId ?? null, row.device_code);
    return c.json({ ok: true, approved: true, device: row.device_name });
  });

  app.get("/identities", requireDevice(db), (c: Context<Env>) =>
    c.json(
      db
        .prepare("SELECT provider, created_at AS createdAt FROM identities WHERE user_id = ? UNION ALL SELECT 'passkey', created_at FROM passkeys WHERE user_id = ? ORDER BY createdAt")
        .all(c.get("userId"), c.get("userId")),
    ),
  );

  app.get("/devices", requireDevice(db), (c: Context<Env>) =>
    c.json(
      (
        db
          .prepare("SELECT id, name, created_at AS createdAt, last_used_at AS lastUsedAt FROM devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at")
          .all(c.get("userId")) as { id: string }[]
      ).map((d) => ({ ...d, current: d.id === c.get("deviceId") })),
    ),
  );

  app.delete("/devices/current", requireDevice(db), (c: Context<Env>) => {
    revokeDevice(db, c.get("deviceId"));
    clearSession(c);
    return c.json({ ok: true });
  });

  app.delete("/devices/:id", requireDevice(db), (c: Context<Env>) => {
    const owned = db.prepare("SELECT id FROM devices WHERE id = ? AND user_id = ? AND revoked_at IS NULL").get(c.req.param("id") ?? "", c.get("userId")) as { id: string } | undefined;
    if (!owned) return c.json({ error: "no such device" }, 404);
    revokeDevice(db, owned.id);
    return c.json({ ok: true });
  });
}

/** One page: sign in with Apple, then approve or deny the code a device is showing. */
/**
 * The code is typed, never filled in from the link: a pre-filled code is how
 * someone else's sign-in, sent as a link, gets approved in one click.
 */
function approvePage(passkeyDomain: string | null): string {
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
<p id="pk" hidden><button id="passkey">Approve with a passkey</button></p>
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
// A passkey works only on the domain it is bound to, so it is offered only there.
const PASSKEY_DOMAIN=${JSON.stringify(passkeyDomain)};
const b64u={
  dec:s=>Uint8Array.from(atob(s.replace(/-/g,"+").replace(/_/g,"/")+"===".slice((s.length+3)%4)),c=>c.charCodeAt(0)),
  enc:b=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"")
};
if(PASSKEY_DOMAIN&&(location.hostname===PASSKEY_DOMAIN||location.hostname.endsWith("."+PASSKEY_DOMAIN))&&window.PublicKeyCredential){document.getElementById("pk").hidden=false;}
document.getElementById("passkey").onclick=async()=>{
  const msg=document.getElementById("msg");
  try{
    const o=await (await fetch("/auth/passkey/options",{method:"POST"})).json();
    const cred=await navigator.credentials.get({publicKey:{challenge:b64u.dec(o.options.challenge),rpId:o.options.rpId,userVerification:o.options.userVerification,timeout:o.options.timeout}});
    const r=cred.response;
    const response={id:cred.id,rawId:b64u.enc(cred.rawId),type:cred.type,clientExtensionResults:{},
      response:{clientDataJSON:b64u.enc(r.clientDataJSON),authenticatorData:b64u.enc(r.authenticatorData),signature:b64u.enc(r.signature),userHandle:r.userHandle?b64u.enc(r.userHandle):undefined}};
    const res=await fetch("/approve",{method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({userCode:document.getElementById("code").value,approve:true,passkey:{challengeId:o.challengeId,response}})});
    const body=await res.json();
    msg.textContent=res.ok?"Approved "+body.device+". You can close this page.":body.error;
  }catch(e){msg.textContent="The passkey did not finish: "+(e.message||e);}
};
</script></body></html>`;
}
