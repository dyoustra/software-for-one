import { randomBytes } from "node:crypto";
import type { Context, Hono } from "hono";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { Db } from "./db.js";
import { accountAllowed, hashToken, issueDevice, removePasskey, requireDevice, type Allowlists, type Env } from "./auth.js";

export interface PasskeyConfig {
  /** The domain passkeys are bound to, forever (SIGN_IN_SPEC §6). */
  rpID: string;
  /** Pages allowed to use them: that domain, where the approval page and the hosted web app live. */
  origins: string[];
}

export const PASSKEYS: PasskeyConfig = { rpID: "sfo.dannyyoustra.com", origins: ["https://sfo.dannyyoustra.com"] };

/**
 * The app proves it belongs to the passkeys' domain through this file, which
 * names it by team and bundle id. Both of the person's Apple teams are
 * listed; iOS accepts the app when either signs it.
 */
export const APPLE_APP_SITE_ASSOCIATION = { webcredentials: { apps: ["C8YMKXNGLP.com.youstra.sfo", "K8FHN3DJNA.com.youstra.sfo"] } };

const CHALLENGE_MS = 5 * 60_000;

type Row = { id: string; user_id: string; public_key: Uint8Array; counter: number; transports: string | null };

/**
 * Passkeys, added to an account already signed in and never starting one
 * (SIGN_IN_SPEC §6): a passkey has no outside identity an allowlist could
 * check, so it signs in only to an account that still has an allowlisted
 * method. Each challenge is single-use and short-lived.
 */
export function passkeys(db: Db, allowlists: Allowlists, config: PasskeyConfig = PASSKEYS) {
  const challenges = new Map<string, { challenge: string; userId?: string; expires: number }>();
  const take = (key: string) => {
    const c = challenges.get(key);
    challenges.delete(key);
    return c && c.expires > Date.now() ? c : null;
  };
  const keep = (key: string, challenge: string, userId?: string) => {
    for (const [k, c] of challenges) if (c.expires < Date.now()) challenges.delete(k);
    challenges.set(key, { challenge, userId, expires: Date.now() + CHALLENGE_MS });
  };

  /** The account and passkey a passkey answer signs in with, or null. */
  async function verifySignIn(challengeId: string, response: AuthenticationResponseJSON): Promise<{ userId: string; passkeyId: string } | null> {
    const waiting = take(`auth:${hashToken(challengeId)}`);
    if (!waiting || typeof response?.id !== "string") return null;
    // Only a passkey whose adding device is still live: one left by a revoked
    // device is gone already, and this refuses one that slipped past.
    const row = db
      .prepare("SELECT p.* FROM passkeys p LEFT JOIN devices d ON d.id = p.device_id WHERE p.id = ? AND (p.device_id IS NULL OR d.revoked_at IS NULL)")
      .get(response.id) as Row | undefined;
    if (!row) return null;
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: waiting.challenge,
      expectedOrigin: config.origins,
      expectedRPID: config.rpID,
      requireUserVerification: true,
      credential: { id: row.id, publicKey: new Uint8Array(row.public_key), counter: row.counter, transports: row.transports ? (JSON.parse(row.transports) as string[]) : undefined },
    }).catch(() => null);
    if (!result?.verified) return null;
    db.prepare("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?").run(result.authenticationInfo.newCounter, new Date().toISOString(), row.id);
    return accountAllowed(db, row.user_id, allowlists) ? { userId: row.user_id, passkeyId: row.id } : null;
  }

  function routes(app: Hono<Env>): void {
    const auth = requireDevice(db);

    app.get("/.well-known/apple-app-site-association", (c) => c.json(APPLE_APP_SITE_ASSOCIATION));

    // Adding one: the signed-in account asks for options, the device makes
    // the passkey, and sends back what it made.
    app.post("/passkeys/options", auth, async (c: Context<Env>) => {
      const userId = c.get("userId");
      const existing = db.prepare("SELECT id, transports FROM passkeys WHERE user_id = ?").all(userId) as { id: string; transports: string | null }[];
      const options = await generateRegistrationOptions({
        rpName: "sfo",
        rpID: config.rpID,
        userName: "sfo",
        userDisplayName: "sfo",
        userID: new TextEncoder().encode(userId),
        attestationType: "none",
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        excludeCredentials: existing.map((p) => ({ id: p.id, transports: p.transports ? (JSON.parse(p.transports) as string[]) : undefined })),
      });
      keep(`reg:${userId}`, options.challenge, userId);
      return c.json(options);
    });

    app.post("/passkeys", auth, async (c: Context<Env>) => {
      const userId = c.get("userId");
      const body = (await c.req.json().catch(() => ({}))) as { response?: RegistrationResponseJSON; name?: string };
      const waiting = take(`reg:${userId}`);
      if (!waiting || !body.response) return c.json({ error: "start again: that request expired" }, 400);
      const result = await verifyRegistrationResponse({
        response: body.response,
        expectedChallenge: waiting.challenge,
        expectedOrigin: config.origins,
        expectedRPID: config.rpID,
        requireUserVerification: true,
      }).catch((err: unknown) => ({ verified: false as const, error: err }));
      if (!result.verified) return c.json({ error: "that passkey could not be checked" }, 400);
      const { credential } = result.registrationInfo;
      if (db.prepare("SELECT 1 FROM passkeys WHERE id = ?").get(credential.id)) return c.json({ error: "that passkey is already added" }, 409);
      // Only while the adding device is still live, checked in the same statement.
      const inserted = db
        .prepare(
          "INSERT INTO passkeys (id, user_id, public_key, counter, transports, name, created_at, device_id) SELECT ?, ?, ?, ?, ?, ?, ?, id FROM devices WHERE id = ? AND revoked_at IS NULL",
        )
        .run(credential.id, userId, credential.publicKey, credential.counter, credential.transports ? JSON.stringify(credential.transports) : null, (body.name ?? "Passkey").slice(0, 80), new Date().toISOString(), c.get("deviceId"));
      if (inserted.changes === 0) return c.json({ error: "this device has been signed out" }, 401);
      return c.json({ ok: true, id: credential.id });
    });

    app.get("/passkeys", auth, (c: Context<Env>) =>
      c.json(
        db
          .prepare("SELECT p.id, p.name, p.created_at AS createdAt, p.last_used_at AS lastUsedAt, d.name AS device FROM passkeys p LEFT JOIN devices d ON d.id = p.device_id WHERE p.user_id = ? ORDER BY p.created_at")
          .all(c.get("userId")),
      ),
    );

    app.delete("/passkeys/:id", auth, (c: Context<Env>) => {
      const mine = db.prepare("SELECT id FROM passkeys WHERE id = ? AND user_id = ?").get(c.req.param("id") ?? "", c.get("userId")) as { id: string } | undefined;
      if (!mine) return c.json({ error: "no such passkey" }, 404);
      removePasskey(db, mine.id);
      return c.json({ ok: true });
    });

    // Signing in: any passkey for this domain may answer; the account is the
    // one it was added to.
    app.post("/auth/passkey/options", async (c) => {
      const options = await generateAuthenticationOptions({ rpID: config.rpID, userVerification: "required" });
      const challengeId = randomBytes(24).toString("base64url");
      keep(`auth:${hashToken(challengeId)}`, options.challenge);
      return c.json({ challengeId, options });
    });

    app.post("/auth/passkey", async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { challengeId?: string; response?: AuthenticationResponseJSON; deviceName?: string };
      const signedIn = body.challengeId && body.response ? await verifySignIn(body.challengeId, body.response) : null;
      if (!signedIn) return c.json({ error: "that passkey did not sign in" }, 403);
      return c.json({ token: issueDevice(db, signedIn.userId, (body.deviceName || "a device").slice(0, 80), signedIn.passkeyId).token });
    });
  }

  return { routes, verifySignIn, domain: config.rpID };
}

export type Passkeys = ReturnType<typeof passkeys>;
