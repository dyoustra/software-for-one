import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { Db } from "./db.js";
import type { Vault } from "./credentials.js";
import type { VercelApi } from "./vercel.js";
import type { SpriteCli } from "../core/sprite.js";
import { ContractSchema, type Contract } from "../core/contracts.js";

/** More than this and a deploy is refused rather than uploaded file by file. */
const MAX_FILES = 5_000;
const MAX_BYTES = 100 * 1024 * 1024;
const UPLOADS_AT_ONCE = 8;
const READY_WAIT_MS = 8 * 60_000;
const POLL_MS = 3_000;

export type PublishRow = { id: string; user_id: string; sprite: string };

export interface PublisherDeps {
  db: Db;
  vault: Vault;
  sprites: SpriteCli;
  vercel: VercelApi;
  /** Work still running after its request returned; shutdown waits for it. */
  inflight: Set<Promise<unknown>>;
  log?: (m: string) => void;
  /** How long to wait between looks at a deployment; tests shorten it. */
  pollMs?: number;
}

/**
 * Reads the project's contract on its Sprite (a regular file only), and the
 * commit it is at. Plain shell, as the log and results scripts are.
 */
const CONTRACT_AND_HEAD = `
p="\${SFO_HOME:-$HOME/.sfo}/$1"
git -C "$p" rev-parse HEAD
f="$p/.sfo/CONTRACTS.json"
if [ -f "$f" ] && [ ! -L "$f" ]; then cat "$f"; fi
`;

/** The tracked files at `root` of the committed tree, as a tar on the Sprite: nothing untracked, no build output. */
const ARCHIVE = `set -e
p="\${SFO_HOME:-$HOME/.sfo}/$1"
out="/tmp/sfo-publish-$1.tar"
if [ "$2" = "." ]; then git -C "$p" archive --format=tar -o "$out" HEAD; else git -C "$p" archive --format=tar -o "$out" "HEAD:$2"; fi
echo "$out"
`;

function set(db: Db, id: string, fields: Record<string, string | null>): void {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE projects SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => fields[k]), new Date().toISOString(), id);
}

/** Every regular file under `dir`, relative, skipping symlinks: what the host builds from. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) out.push(child);
    }
  };
  walk("");
  return out;
}

async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

/**
 * Takes a delivered web project live (WEB_AND_MOBILE_SPEC §4): the project's
 * committed files go to Vercel, which builds and serves them. The person's
 * token is used here only; it never reaches the Sprite, and the project's
 * code runs in Vercel's builder, not here. Runs after its request has
 * returned; the project's row says how it is going.
 */
export function publisher(deps: PublisherDeps) {
  const log = deps.log ?? console.log;

  async function contractAndHead(row: PublishRow): Promise<{ head: string; contract: Contract | null }> {
    const r = await deps.sprites.exec(row.sprite, CONTRACT_AND_HEAD, [row.id]);
    if (r.status !== 0) throw new Error(`could not read the project on its machine: ${r.stdout.trim().slice(0, 200)}`);
    const nl = r.stdout.indexOf("\n");
    const head = r.stdout.slice(0, nl).trim();
    const text = r.stdout.slice(nl + 1).trim();
    if (!text) return { head, contract: null };
    const parsed = ContractSchema.safeParse(JSON.parse(text));
    return { head, contract: parsed.success ? parsed.data : null };
  }

  async function run(row: PublishRow, contract: Contract, head: string): Promise<void> {
    const publish = contract.publish!;
    const token = deps.vault.get(row.user_id, "vercel_token");
    if (!token) {
      set(deps.db, row.id, { publish_state: "needs_connection", publish_error: "Connect Vercel to put it online." });
      return;
    }
    set(deps.db, row.id, { publish_state: "deploying", publish_error: null });
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "sfo-publish-"));
    try {
      const archived = await deps.sprites.exec(row.sprite, ARCHIVE, [row.id, publish.root]);
      if (archived.status !== 0) throw new Error(`could not package it: ${archived.stdout.trim().slice(0, 200)}`);
      const tar = path.join(scratch, "source.tar");
      await deps.sprites.pull(row.sprite, archived.stdout.trim().split("\n").pop() ?? "", tar);
      const tree = path.join(scratch, "tree");
      fs.mkdirSync(tree);
      const untar = spawnSync("tar", ["-xf", tar, "-C", tree], { encoding: "utf8" });
      if (untar.status !== 0) throw new Error(`could not unpack it: ${untar.stderr}`);

      const files = filesUnder(tree);
      const bytes = files.reduce((n, f) => n + fs.statSync(path.join(tree, f)).size, 0);
      if (files.length > MAX_FILES || bytes > MAX_BYTES) throw new Error(`it is too large to publish (${files.length} files, ${Math.round(bytes / 1e6)} MB)`);

      const project = await deps.vercel.ensureProject(token, row.id);
      const uploaded = await inBatches(files, UPLOADS_AT_ONCE, async (file) => ({ file, ...(await deps.vercel.uploadFile(token, fs.readFileSync(path.join(tree, file)))) }));
      const { id } = await deps.vercel.deploy(token, project, uploaded, publish.framework);

      const deadline = Date.now() + READY_WAIT_MS;
      for (;;) {
        const d = await deps.vercel.deployment(token, id);
        if (d.state === "READY") {
          const host = d.aliases[0] ?? d.url;
          set(deps.db, row.id, { publish_state: "live", published_url: `https://${host}`, published_commit: head, published_at: new Date().toISOString(), publish_error: null });
          log(`published ${row.id} at https://${host}`);
          return;
        }
        if (d.state === "ERROR" || d.state === "CANCELED") throw new Error(d.error ?? `Vercel's build ended ${d.state.toLowerCase()}`);
        if (Date.now() > deadline) throw new Error("Vercel's build took too long to finish");
        await new Promise((r) => setTimeout(r, deps.pollMs ?? POLL_MS));
      }
    } catch (err) {
      set(deps.db, row.id, { publish_state: "failed", publish_error: (err instanceof Error ? err.message : String(err)).slice(0, 500) });
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }

  return {
    /**
     * After a run delivers: notes the commit it is at, and takes a web project
     * live the first time. Later deliveries wait for `publish`.
     */
    async delivered(row: PublishRow): Promise<void> {
      const { head, contract } = await contractAndHead(row);
      set(deps.db, row.id, { head_commit: head });
      if (contract?.publish?.kind !== "web") return;
      const was = deps.db.prepare("SELECT publish_state FROM projects WHERE id = ?").get(row.id) as { publish_state: string | null } | undefined;
      if (was?.publish_state) return;
      const job = run(row, contract, head);
      deps.inflight.add(job);
      void job.finally(() => deps.inflight.delete(job));
    },

    /** The person asked for it: what the project is at now goes live. */
    async publish(row: PublishRow): Promise<string | null> {
      const { head, contract } = await contractAndHead(row);
      set(deps.db, row.id, { head_commit: head });
      if (contract?.publish?.kind !== "web") return "it has nothing to put online";
      const job = run(row, contract, head);
      deps.inflight.add(job);
      void job.finally(() => deps.inflight.delete(job));
      return null;
    },
  };
}

export type Publisher = ReturnType<typeof publisher>;
