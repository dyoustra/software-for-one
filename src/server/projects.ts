import fs from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { Context, Hono } from "hono";
import { stream } from "hono/streaming";
import type { Db } from "./db.js";
import { requireDevice, type Env } from "./auth.js";
import { githubToken, type GitHubOAuth, type Vault } from "./credentials.js";
import { PROJECT_ID, provisionProject, type GitHub, type SpriteCredential } from "../core/provision.js";
import { DEFAULT_PREFERENCES } from "../core/preferences.js";
import type { SpriteCli } from "../core/sprite.js";

export interface ProjectDeps {
  db: Db;
  vault: Vault;
  /** Drives Sprites: the REST API on the server. */
  sprites: SpriteCli;
  /** Repos and deploy keys, with the person's own GitHub token. */
  repos?: GitHub;
  oauth: GitHubOAuth;
}

type ProjectRow = { id: string; user_id: string; sprite: string; repo: string | null; status: string; summary: string | null; created_at: string; updated_at: string };

const now = (): string => new Date().toISOString();

function present(row: ProjectRow) {
  return { id: row.id, sprite: row.sprite, repo: row.repo, status: row.status, summary: row.summary ? JSON.parse(row.summary) : null, createdAt: row.created_at, updatedAt: row.updated_at };
}

/**
 * What a project's Sprite pays for model calls with, from the person's stored
 * credentials: the subscription token if they gave one, else the API key.
 */
function spriteCredentials(vault: Vault, userId: string): { credentials: SpriteCredential[]; profileJson: string } {
  const token = vault.get(userId, "claude_token");
  const key = token ? null : vault.get(userId, "anthropic_api_key");
  const credentials: SpriteCredential[] = token
    ? [{ file: "claude-token", value: token, method: "claude_subscription" }]
    : key
      ? [{ file: "api-key", value: key, method: "anthropic_api_key" }]
      : [];
  const method = credentials[0]?.method ?? "claude_subscription";
  const profileJson = JSON.stringify({
    modelAccess: [method],
    apiKey: method === "anthropic_api_key" ? { source: "env", var: "ANTHROPIC_API_KEY" } : null,
    sfoPrefers: method,
    fallbackToApiKey: false,
    updatedAt: now(),
  });
  return { credentials, profileJson };
}

export function projectRoutes(app: Hono<Env>, deps: ProjectDeps): void {
  const { db, vault, sprites } = deps;
  const auth = requireDevice(db);

  /** The project, if it is this person's; anyone else's is indistinguishable from none. */
  const owned = (c: Context<Env>): ProjectRow | null => {
    if (!PROJECT_ID.test(c.req.param("id") ?? "")) return null;
    const row = db.prepare("SELECT * FROM projects WHERE id = ? AND user_id = ? AND status != 'destroyed'").get(c.req.param("id") ?? "", c.get("userId")) as ProjectRow | undefined;
    return row ?? null;
  };

  /** Runs sfo on the project's Sprite; arguments reach it as data, never as script. */
  const sfo = (row: ProjectRow, args: string[], input?: string) => sprites.exec(row.sprite, `cd ~ && exec sfo "$@"`, args, input === undefined ? {} : { input });

  /** Asks the Sprite how the project is, and keeps the answer for when it sleeps. */
  const refresh = async (row: ProjectRow): Promise<ProjectRow> => {
    const r = await sprites.exec(row.sprite, "exec sfo status --json").catch(() => null);
    if (!r || r.status !== 0) return row;
    try {
      const summary = (JSON.parse(r.stdout) as { id: string }[]).find((p) => p.id === row.id) ?? null;
      db.prepare("UPDATE projects SET summary = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(summary), now(), row.id);
      return { ...row, summary: JSON.stringify(summary), updated_at: now() };
    } catch {
      return row;
    }
  };

  // Creating a project holds its request for the whole setup (about a minute),
  // reporting each step as a line of JSON: the Machine is never stopped under
  // it, because the work is the request.
  app.post("/projects", auth, async (c: Context<Env>) => {
    const body = (await c.req.json().catch(() => ({}))) as { idea?: string; budget?: string; run?: boolean; preferencesJson?: string; sfoMd?: string | null };
    if (!body.idea?.trim()) return c.json({ error: "idea is required" }, 400);
    const userId = c.get("userId");
    const { credentials, profileJson } = spriteCredentials(vault, userId);
    if (credentials.length === 0) return c.json({ error: "no model credential stored — `sfo login` from your Mac to upload one, or add an API key" }, 400);
    const token = await githubToken(vault, deps.oauth, userId).catch(() => null);

    return stream(c, async (out) => {
      const say = (line: Record<string, unknown>) => out.write(`${JSON.stringify(line)}\n`);
      try {
        const made = await provisionProject(
          {
            idea: body.idea ?? "",
            budget: body.budget,
            run: body.run !== false,
            credentials,
            profileJson,
            preferencesJson: body.preferencesJson ?? JSON.stringify(DEFAULT_PREFERENCES),
            sfoMd: body.sfoMd ?? null,
            githubToken: token,
          },
          { cli: sprites, github: deps.repos, log: (message) => void say({ progress: message }) },
        );
        db.prepare("INSERT INTO projects (id, user_id, sprite, repo, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'ready', ?, ?)").run(
          made.id,
          userId,
          made.sprite,
          made.repo,
          now(),
          now(),
        );
        const row = await refresh(db.prepare("SELECT * FROM projects WHERE id = ?").get(made.id) as ProjectRow);
        await say({ done: true, project: present(row), started: made.started });
      } catch (err) {
        await say({ error: err instanceof Error ? err.message : String(err) });
      }
    });
  });

  app.get("/projects", auth, (c: Context<Env>) =>
    c.json((db.prepare("SELECT * FROM projects WHERE user_id = ? AND status != 'destroyed' ORDER BY created_at DESC").all(c.get("userId")) as ProjectRow[]).map(present)),
  );

  app.get("/projects/:id", auth, async (c: Context<Env>) => {
    const row = owned(c);
    return row ? c.json(present(await refresh(row))) : c.json({ error: "no such project" }, 404);
  });

  app.get("/projects/:id/questions", auth, async (c: Context<Env>) => {
    const row = owned(c);
    if (!row) return c.json({ error: "no such project" }, 404);
    const r = await sfo(row, ["questions", row.id]);
    return r.status === 0 ? c.json(JSON.parse(r.stdout)) : c.json({ error: r.stdout.trim() }, 502);
  });

  // Answers are saved with `sfo answer --from` (all open questions, only
  // those), and the run resumes.
  app.post("/projects/:id/answers", auth, async (c: Context<Env>) => {
    const row = owned(c);
    if (!row) return c.json({ error: "no such project" }, 404);
    const answers = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!answers || typeof answers !== "object" || Object.values(answers).some((v) => typeof v !== "string")) {
      return c.json({ error: 'answers are {"Q-001": "B", …}' }, 400);
    }
    const saved = await sfo(row, ["answer", row.id, "--from", "-"], JSON.stringify(answers));
    if (saved.status !== 0) return c.json({ error: saved.stdout.trim() }, 400);
    const ran = await sfo(row, ["run", row.id]);
    return c.json({ ok: true, resumed: ran.status === 0, message: ran.stdout.trim() });
  });

  app.post("/projects/:id/feedback", auth, async (c: Context<Env>) => {
    const row = owned(c);
    if (!row) return c.json({ error: "no such project" }, 404);
    const { text } = (await c.req.json().catch(() => ({}))) as { text?: string };
    if (!text?.trim()) return c.json({ error: "text is required" }, 400);
    const r = await sfo(row, ["feedback", row.id, text]);
    return r.status === 0 ? c.json({ ok: true, message: r.stdout.trim() }) : c.json({ error: r.stdout.trim() }, 400);
  });

  for (const action of ["run", "retry", "stop"] as const) {
    app.post(`/projects/:id/${action}`, auth, async (c: Context<Env>) => {
      const row = owned(c);
      if (!row) return c.json({ error: "no such project" }, 404);
      const r = await sfo(row, [action, row.id]);
      return r.status === 0 ? c.json({ ok: true, message: r.stdout.trim() }) : c.json({ error: r.stdout.trim() }, 400);
    });
  }

  // The project's git bundle, for pull, check and install on the person's machine.
  app.get("/projects/:id/bundle", auth, async (c: Context<Env>) => {
    const row = owned(c);
    if (!row) return c.json({ error: "no such project" }, 404);
    const remote = `/tmp/sfo-${row.id}.bundle`;
    const made = await sprites.exec(row.sprite, `cd ~/.sfo/"$1" && git bundle create -q "$2" --all`, [row.id, remote]);
    if (made.status !== 0) return c.json({ error: "could not bundle the project" }, 502);
    const local = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sfo-bundle-")), `${row.id}.bundle`);
    await sprites.pull(row.sprite, remote, local);
    const bytes = fs.readFileSync(local);
    fs.rmSync(path.dirname(local), { recursive: true, force: true });
    return c.body(new Uint8Array(bytes), 200, { "content-type": "application/octet-stream" });
  });

  app.delete("/projects/:id", auth, async (c: Context<Env>) => {
    const row = owned(c);
    if (!row) return c.json({ error: "no such project" }, 404);
    await sprites.destroy(row.sprite);
    db.prepare("UPDATE projects SET status = 'destroyed', updated_at = ? WHERE id = ?").run(now(), row.id);
    return c.json({ ok: true, repo: row.repo });
  });

  // A project made before the control plane existed, on a Sprite the person
  // reached with their own Sprites access. The server's token reaches every
  // Sprite in the organization, so naming one proves nothing: the person must
  // write a one-time challenge onto it with their own access, which the server
  // then reads back. A Sprite already behind a project cannot be claimed again.
  const challenges = new Map<string, { userId: string; id: string; sprite: string; expires: number }>();
  const SPRITE = /^sfo-[0-9a-f]{8}$/;
  const PROOF = (id: string) => `~/.sfo/${id}/.sfo/import-proof`;

  app.post("/projects/import/challenge", auth, async (c: Context<Env>) => {
    const { id, sprite } = (await c.req.json().catch(() => ({}))) as { id?: string; sprite?: string };
    if (!id || !PROJECT_ID.test(id) || !sprite || !SPRITE.test(sprite)) return c.json({ error: "id and sprite must be an sfo project id and Sprite name" }, 400);
    if (db.prepare("SELECT 1 FROM projects WHERE id = ? OR sprite = ?").get(id, sprite)) return c.json({ error: "that project or Sprite is already claimed" }, 409);
    const nonce = randomBytes(24).toString("base64url");
    challenges.set(nonce, { userId: c.get("userId"), id, sprite, expires: Date.now() + 10 * 60_000 });
    return c.json({ nonce, path: PROOF(id) });
  });

  app.post("/projects/import", auth, async (c: Context<Env>) => {
    const { nonce, repo } = (await c.req.json().catch(() => ({}))) as { nonce?: string; repo?: string | null };
    const ch = nonce ? challenges.get(nonce) : undefined;
    if (nonce) challenges.delete(nonce);
    if (!ch || ch.userId !== c.get("userId") || ch.expires < Date.now()) return c.json({ error: "no such challenge — start the import again" }, 400);
    const proof = await sprites.exec(ch.sprite, `cat ~/.sfo/"$1"/.sfo/import-proof && rm -f ~/.sfo/"$1"/.sfo/import-proof`, [ch.id]).catch(() => null);
    if (!proof || proof.status !== 0 || proof.stdout.trim() !== nonce) return c.json({ error: "the Sprite does not hold the challenge — it must be written with your own Sprites access" }, 403);
    if (db.prepare("SELECT 1 FROM projects WHERE id = ? OR sprite = ?").get(ch.id, ch.sprite)) return c.json({ error: "that project or Sprite is already claimed" }, 409);
    const listed = await sprites.exec(ch.sprite, "exec sfo status --json").catch(() => null);
    const summary = listed?.status === 0 ? ((JSON.parse(listed.stdout) as { id: string }[]).find((p) => p.id === ch.id) ?? null) : null;
    if (!summary) return c.json({ error: `${ch.sprite} does not hold ${ch.id}` }, 400);
    db.prepare("INSERT INTO projects (id, user_id, sprite, repo, status, summary, created_at, updated_at) VALUES (?, ?, ?, ?, 'ready', ?, ?, ?)").run(
      ch.id,
      c.get("userId"),
      ch.sprite,
      typeof repo === "string" && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(repo) ? repo : null,
      JSON.stringify(summary),
      now(),
      now(),
    );
    return c.json({ ok: true });
  });
}
