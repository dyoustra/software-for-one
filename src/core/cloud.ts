import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import { projectsRoot, projectDir, type Env } from "./paths.js";
import { readKey, type KeyReader, type Profile } from "./access.js";
import { commitStage, NO_INTERFERENCE } from "./repo.js";
import { readPreferences, readSfoMd } from "./preferences.js";
import type { SpriteCli } from "./sprite.js";
import { provisionProject, type GitHub, type SpriteCredential } from "./provision.js";

export const CLOUD_FILE = "cloud.json";

const SummarySchema = z
  .object({ id: z.string(), title: z.string(), currentStage: z.string(), status: z.string(), note: z.string().optional(), next: z.string().optional() })
  .passthrough();
export type CloudSummary = z.infer<typeof SummarySchema>;

const EntrySchema = z.object({
  sprite: z.string(),
  repo: z.string().nullable(),
  createdAt: z.string(),
  /** The project as `sfo status` last saw it on its Sprite. */
  summary: SummarySchema.nullable(),
});
export type CloudEntry = z.infer<typeof EntrySchema>;

const IndexSchema = z.object({ projects: z.record(z.string(), EntrySchema) });

function indexPath(env?: Env): string {
  return path.join(projectsRoot(env), CLOUD_FILE);
}

export function readCloud(env?: Env): Record<string, CloudEntry> {
  try {
    return IndexSchema.parse(JSON.parse(fs.readFileSync(indexPath(env), "utf8"))).projects;
  } catch {
    return {};
  }
}

function writeCloud(projects: Record<string, CloudEntry>, env?: Env): void {
  fs.mkdirSync(projectsRoot(env), { recursive: true });
  fs.writeFileSync(indexPath(env), `${JSON.stringify({ projects }, null, 2)}\n`);
}

export function cloudEntry(id: string, env?: Env): CloudEntry | null {
  // Own keys only: "constructor" or "__proto__" is not a cloud project.
  const all = readCloud(env);
  return Object.hasOwn(all, id) ? all[id] : null;
}

function saveEntry(id: string, entry: CloudEntry | null, env?: Env): void {
  const all = readCloud(env);
  if (entry) all[id] = entry;
  else delete all[id];
  writeCloud(all, env);
}

export interface CloudDeps {
  cli: SpriteCli;
  env?: Env;
  readKeyWith?: KeyReader;
  github?: GitHub;
  log?: (message: string) => void;
}

/**
 * What a Sprite needs to pay for model calls, from this person's profile:
 * the subscription token when they prefer the plan and have one, the API key
 * otherwise. Throws when neither can be found, before anything is created.
 */
function credentialsFor(profile: Profile, env: Env, readKeyWith: KeyReader): SpriteCredential[] {
  const token = profile.subscriptionToken ? readKeyWith(profile.subscriptionToken, env) : null;
  // A key on a Sprite is a key that can be billed, so it goes only where it
  // would be used: preferred, the fallback, or the only credential there is.
  const keyUsed = profile.sfoPrefers === "anthropic_api_key" || profile.fallbackToApiKey || !token;
  const key = profile.apiKey && keyUsed ? readKeyWith(profile.apiKey, env) : null;
  const found = [
    ...(token && profile.modelAccess.includes("claude_subscription") ? [{ file: "claude-token" as const, value: token, method: "claude_subscription" as const }] : []),
    ...(key && profile.modelAccess.includes("anthropic_api_key") ? [{ file: "api-key" as const, value: key, method: "anthropic_api_key" as const }] : []),
  ];
  if (found.length === 0) {
    throw new Error(
      "a cloud project needs a credential it can take with it: `claude setup-token`, store the token in your Keychain, then `sfo profile set cloud-token keychain:<service>` — or an API key with `sfo profile set key`. Or build on this machine with `sfo new --local`",
    );
  }
  return found;
}

function remoteProfile(profile: Profile, methods: Profile["sfoPrefers"][]): string {
  return JSON.stringify({
    modelAccess: methods,
    apiKey: methods.includes("anthropic_api_key") ? { source: "env", var: "ANTHROPIC_API_KEY" } : null,
    sfoPrefers: methods.includes(profile.sfoPrefers) ? profile.sfoPrefers : methods[0],
    fallbackToApiKey: profile.fallbackToApiKey && methods.length > 1,
    updatedAt: new Date().toISOString(),
  });
}

/** Captures an idea on a new Sprite of its own, with this machine's credentials, and records where it lives. */
export async function newCloudProject(
  idea: string,
  opts: { budget?: string; run: boolean },
  profile: Profile,
  deps: CloudDeps,
): Promise<string> {
  const env = deps.env ?? process.env;
  const readKeyWith = deps.readKeyWith ?? readKey;
  const credentials = credentialsFor(profile, env, readKeyWith);
  const githubToken = profile.githubToken ? readKeyWith(profile.githubToken, env) : null;
  if (profile.githubToken && !githubToken) throw new Error("your GitHub token was not found — fix it, or `sfo profile set github none`");

  const made = await provisionProject(
    {
      idea,
      budget: opts.budget,
      run: opts.run,
      credentials,
      profileJson: remoteProfile(profile, credentials.map((c) => c.method)),
      preferencesJson: `${JSON.stringify(readPreferences(env))}\n`,
      sfoMd: readSfoMd(env),
      githubToken,
    },
    { cli: deps.cli, github: deps.github, log: deps.log },
  );
  saveEntry(made.id, { sprite: made.sprite, repo: made.repo, createdAt: new Date().toISOString(), summary: null }, env);
  if (made.started) (deps.log ?? console.log)("`sfo status` to follow it");
  await refreshCloud(made.id, deps);
  return made.id;
}

/** Runs an sfo command on the project's Sprite, attached to this terminal. */
export async function forward(id: string, argv: string[], deps: CloudDeps): Promise<number> {
  const entry = cloudEntry(id, deps.env);
  if (!entry) throw new Error(`${id} is not a cloud project`);
  const { status } = await deps.cli.exec(entry.sprite, `exec sfo "$@"`, argv, { attach: true });
  await refreshCloud(id, deps);
  return status;
}

/** Asks the project's Sprite how the project is doing, and remembers the answer. */
export async function refreshCloud(id: string, deps: CloudDeps): Promise<CloudSummary | null> {
  const entry = cloudEntry(id, deps.env);
  if (!entry) return null;
  const r = await deps.cli.exec(entry.sprite, `exec sfo status --json`);
  if (r.status !== 0) return entry.summary;
  try {
    const all = z.array(SummarySchema).parse(JSON.parse(r.stdout));
    const summary = all.find((p) => p.id === id) ?? null;
    saveEntry(id, { ...entry, summary }, deps.env);
    return summary;
  } catch {
    return entry.summary;
  }
}

/**
 * Every cloud project as last seen, asking again only about those that were
 * running: nothing else changes while nobody acts on it, and asking wakes a
 * Sprite.
 */
export async function cloudSummaries(deps: CloudDeps): Promise<CloudSummary[]> {
  const out: CloudSummary[] = [];
  for (const [id, entry] of Object.entries(readCloud(deps.env))) {
    const summary = !entry.summary || entry.summary.status === "running" ? await refreshCloud(id, deps) : entry.summary;
    if (!summary) continue;
    // The label status would have shown, then where: a note replaces the
    // label, so "on sfo-…" alone would hide that it is running.
    const label = summary.note ?? (summary.status === "awaiting_human" ? "needs you" : summary.status);
    out.push({ ...summary, note: `${label} · on ${entry.sprite}` });
  }
  return out;
}

/**
 * Brings a cloud project to this machine — for checks that need hardware it
 * has — as a git copy in the usual place. The Sprite stays the original.
 */
export async function pullProject(id: string, deps: CloudDeps): Promise<string> {
  const entry = cloudEntry(id, deps.env);
  if (!entry) throw new Error(`${id} is not a cloud project`);
  const remote = `/tmp/sfo-${id}.bundle`;
  const made = await deps.cli.exec(entry.sprite, `cd ~/.sfo/"$1" && git bundle create -q "$2" --all`, [id, remote]);
  if (made.status !== 0) throw new Error(`could not bundle ${id} on ${entry.sprite}`);
  const local = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sfo-pull-")), `${id}.bundle`);
  await deps.cli.pull(entry.sprite, remote, local);
  const dir = projectDir(id, deps.env);
  if (fs.existsSync(path.join(dir, ".git"))) {
    // A copy, not a fork: whatever an install or check left in it gives way
    // to the original. Check results were sent back before this.
    execFileSync("git", [...NO_INTERFERENCE, "fetch", "-q", local, "HEAD"], { cwd: dir, stdio: "pipe" });
    execFileSync("git", [...NO_INTERFERENCE, "reset", "-q", "--hard", "FETCH_HEAD"], { cwd: dir, stdio: "pipe" });
  } else {
    execFileSync("git", [...NO_INTERFERENCE, "clone", "-q", local, dir], { stdio: "pipe" });
  }
  return dir;
}

/** Sends what was done to the local copy (check results) back to the Sprite. */
export async function pushProjectBack(id: string, deps: CloudDeps): Promise<void> {
  const entry = cloudEntry(id, deps.env);
  if (!entry) throw new Error(`${id} is not a cloud project`);
  commitStage(id, "check", deps.env);
  const local = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sfo-push-")), `${id}.bundle`);
  execFileSync("git", [...NO_INTERFERENCE, "bundle", "create", "-q", local, "HEAD"], { cwd: projectDir(id, deps.env), stdio: "pipe" });
  const remote = `/tmp/sfo-${id}-back.bundle`;
  await deps.cli.push(entry.sprite, local, remote);
  const merged = await deps.cli.exec(entry.sprite, `cd ~/.sfo/"$1" && git pull -q --ff-only "$2" HEAD`, [id, remote]);
  if (merged.status !== 0) throw new Error(`could not bring the check results back to ${entry.sprite}: ${merged.stdout.trim()}`);
  await refreshCloud(id, deps);
}

/** Deletes the project's Sprite, and everything on it. Its repo, if any, remains. */
export async function destroyCloudProject(id: string, deps: CloudDeps): Promise<CloudEntry> {
  const entry = cloudEntry(id, deps.env);
  if (!entry) throw new Error(`${id} is not a cloud project`);
  await deps.cli.destroy(entry.sprite);
  saveEntry(id, null, deps.env);
  return entry;
}
