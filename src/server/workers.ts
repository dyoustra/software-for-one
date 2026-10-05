import { randomBytes } from "node:crypto";
import type { Context, Hono } from "hono";
import type { Db } from "./db.js";
import { hashToken, requireDevice, type Env } from "./auth.js";
import type { SpriteCli } from "../core/sprite.js";

/** A notification to a phone, as Expo's push service takes it. */
export interface PushMessage {
  to: string;
  title: string;
  body: string;
  data: { projectId: string } | { sfoVerify: string };
  sound: "default";
}

export type SendPush = (messages: PushMessage[]) => Promise<void>;

export const expoPush: SendPush = async (messages) => {
  if (messages.length === 0) return;
  const res = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(messages),
  });
  if (!res.ok) throw new Error(`Expo push refused (${res.status}): ${(await res.text()).slice(0, 200)}`);
};

/** A token a project's Sprite reports with; only its hash is kept, tied to that one project. */
export function issueWorkerKey(): { token: string; hash: string } {
  const token = `sfow_${randomBytes(32).toString("base64url")}`;
  return { token, hash: hashToken(token) };
}

export function workerRoutes(app: Hono<Env>, deps: { db: Db; sprites: SpriteCli; push: SendPush; log?: (m: string) => void }): void {
  const { db, sprites } = deps;
  const log = deps.log ?? console.log;

  // Registering a push token proves nothing about whose phone it is, so it
  // is used only once verified: a one-time code is pushed to it, and the app,
  // open and signed in on that phone, sends the code back. Possession proven,
  // the token leaves any other account it was registered to.
  app.post("/push-tokens", requireDevice(db), async (c: Context<Env>) => {
    const { token } = (await c.req.json().catch(() => ({}))) as { token?: string };
    if (!token || !/^ExponentPushToken\[[\w-]+\]$/.test(token)) return c.json({ error: "not an Expo push token" }, 400);
    const code = randomBytes(16).toString("base64url");
    db.prepare(
      "INSERT INTO push_tokens (user_id, expo_token, created_at, device_id, code_hash, verified_at) VALUES (?, ?, ?, ?, ?, NULL) ON CONFLICT (user_id, expo_token) DO UPDATE SET device_id = excluded.device_id, code_hash = excluded.code_hash",
    ).run(c.get("userId"), token, new Date().toISOString(), c.get("deviceId"), hashToken(code));
    await deps
      .push([{ to: token, title: "sfo", body: "Notifications are on.", data: { sfoVerify: code }, sound: "default" }])
      .catch((err) => log(`verification push not sent: ${err instanceof Error ? err.message : String(err)}`));
    return c.json({ ok: true, verify: "pending" });
  });

  app.post("/push-tokens/verify", requireDevice(db), async (c: Context<Env>) => {
    const { token, code } = (await c.req.json().catch(() => ({}))) as { token?: string; code?: string };
    const row = token && code
      ? (db.prepare("SELECT code_hash FROM push_tokens WHERE user_id = ? AND expo_token = ? AND device_id = ?").get(c.get("userId"), token, c.get("deviceId")) as { code_hash: string | null } | undefined)
      : undefined;
    if (!token || !row?.code_hash || row.code_hash !== hashToken(code ?? "")) return c.json({ error: "that code is not this phone's" }, 400);
    db.prepare("UPDATE push_tokens SET verified_at = ?, code_hash = NULL WHERE user_id = ? AND expo_token = ?").run(new Date().toISOString(), c.get("userId"), token);
    db.prepare("DELETE FROM push_tokens WHERE expo_token = ? AND user_id != ?").run(token, c.get("userId"));
    return c.json({ ok: true });
  });

  // A project's Sprite reporting that a run stopped for the person, finished,
  // failed or crashed. Its token says which project; it can speak for no other.
  app.post("/workers/events", async (c) => {
    const token = c.req.header("authorization")?.match(/^Bearer (.+)$/)?.[1];
    const row = token
      ? (db
          .prepare("SELECT p.id, p.user_id, p.sprite FROM worker_keys k JOIN projects p ON p.id = k.project_id WHERE k.token_hash = ? AND p.status != 'destroyed'")
          .get(hashToken(token)) as { id: string; user_id: string; sprite: string } | undefined)
      : undefined;
    if (!row) return c.json({ error: "not a worker of any project" }, 401);
    const { title, message } = (await c.req.json().catch(() => ({}))) as { title?: string; message?: string };
    if (typeof title !== "string" || typeof message !== "string") return c.json({ error: "title and message are required" }, 400);
    const at = new Date().toISOString();
    db.prepare("INSERT INTO events (project_id, kind, payload, at) VALUES (?, 'notify', ?, ?)").run(row.id, JSON.stringify({ title: title.slice(0, 200), message: message.slice(0, 2000) }), at);

    // The Sprite is awake (it just spoke), so asking it costs nothing extra.
    const status = await sprites.exec(row.sprite, "exec sfo status --json").catch(() => null);
    if (status?.status === 0) {
      try {
        const summary = (JSON.parse(status.stdout) as { id: string }[]).find((p) => p.id === row.id) ?? null;
        db.prepare("UPDATE projects SET summary = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(summary), at, row.id);
      } catch {
        // A summary that does not parse leaves the last one standing.
      }
    }

    // Only to phones that proved they receive on the token, and are still
    // signed in to this account.
    const tokens = (
      db
        .prepare(
          "SELECT t.expo_token FROM push_tokens t JOIN devices d ON d.id = t.device_id WHERE t.user_id = ? AND d.user_id = t.user_id AND d.revoked_at IS NULL AND t.verified_at IS NOT NULL",
        )
        .all(row.user_id) as { expo_token: string }[]
    ).map((t) => t.expo_token);
    await deps
      .push(tokens.map((to) => ({ to, title: title.replace(/^sfo: /, "").slice(0, 100), body: message.slice(0, 1000), data: { projectId: row.id }, sound: "default" as const })))
      .catch((err) => log(`push for ${row.id} not sent: ${err instanceof Error ? err.message : String(err)}`));
    return c.json({ ok: true });
  });
}
