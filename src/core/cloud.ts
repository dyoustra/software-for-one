import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { projectsRoot, projectDir, type Env } from "./paths.js";
import { readKey, type KeyReader, type Profile } from "./access.js";
import { commitStage, NO_INTERFERENCE } from "./repo.js";
import { readPreferences } from "./preferences.js";
import type { SpriteCli } from "./sprite.js";

export const CLOUD_FILE = "cloud.json";

/** Where every new Sprite gets sfo from. A Sprite runs what is on main. */
export const SFO_REPO = "https://github.com/dyoustra/software-for-one.git";

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

/**
 * Prepares a new Sprite to run sfo. Claude Code comes from its own installer:
 * the copy a Sprite ships with lags and cannot update itself while its
 * launcher is in the way. sfo is cloned from main.
 */
const SETUP = `set -e
if ! readlink ~/.local/bin/claude 2>/dev/null | grep -q /claude/versions/; then
  mv -f ~/.local/bin/claude ~/.local/bin/claude.sprite-wrapper 2>/dev/null || true
  curl -fsSL https://claude.ai/install.sh | bash >/dev/null
fi
rm -rf ~/sfo && git clone -q --depth 1 "$1" ~/sfo
cd ~/sfo && npm ci --no-audit --no-fund --loglevel=error >/dev/null && npm run -s build >/dev/null
ln -sf ~/sfo/dist/cli.js ~/.local/bin/sfo
cat > ~/.sfo-env <<'EOF'
export SFO_CONFINEMENT=vm
[ -r ~/.config/sfo/claude-token ] && export CLAUDE_CODE_OAUTH_TOKEN="$(cat ~/.config/sfo/claude-token)"
[ -r ~/.config/sfo/api-key ] && export ANTHROPIC_API_KEY="$(cat ~/.config/sfo/api-key)"
EOF
for f in ~/.profile ~/.bashrc; do grep -q sfo-env "$f" 2>/dev/null || echo 'source ~/.sfo-env' >> "$f"; done
mkdir -p ~/.sfo && printf '%s\\n' "$2" > ~/.sfo/profile.json
git config --global user.name sfo && git config --global user.email sfo@localhost
claude --version >/dev/null && sfo --version >/dev/null`;

/** Stores one secret on the Sprite, readable only by its user. It travels on stdin, never in arguments. */
const STORE_SECRET = `umask 077; mkdir -p ~/.config/sfo; cat > ~/.config/sfo/"$1"`;

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
function credentialsFor(profile: Profile, env: Env, readKeyWith: KeyReader): { file: string; value: string; method: Profile["sfoPrefers"] }[] {
  const token = profile.subscriptionToken ? readKeyWith(profile.subscriptionToken, env) : null;
  // A key on a Sprite is a key that can be billed, so it goes only where it
  // would be used: preferred, the fallback, or the only credential there is.
  const keyUsed = profile.sfoPrefers === "anthropic_api_key" || profile.fallbackToApiKey || !token;
  const key = profile.apiKey && keyUsed ? readKeyWith(profile.apiKey, env) : null;
  const found = [
    ...(token && profile.modelAccess.includes("claude_subscription") ? [{ file: "claude-token", value: token, method: "claude_subscription" as const }] : []),
    ...(key && profile.modelAccess.includes("anthropic_api_key") ? [{ file: "api-key", value: key, method: "anthropic_api_key" as const }] : []),
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

/** The few GitHub calls a project repo needs. */
export interface GitHub {
  login(token: string): Promise<string>;
  createPrivateRepo(token: string, name: string, description: string): Promise<string>;
  /** A key with write access to this one repo and no other. */
  addDeployKey(token: string, owner: string, repo: string, publicKey: string): Promise<void>;
}

export const github: GitHub = {
  async login(token) {
    const r = await fetch("https://api.github.com/user", { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" } });
    if (!r.ok) throw new Error(`GitHub refused the token (${r.status})`);
    return ((await r.json()) as { login: string }).login;
  },
  async createPrivateRepo(token, name, description) {
    const r = await fetch("https://api.github.com/user/repos", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json" },
      body: JSON.stringify({ name, description, private: true }),
    });
    if (!r.ok) throw new Error(`GitHub would not create ${name} (${r.status}): ${(await r.text()).slice(0, 200)}`);
    return ((await r.json()) as { html_url: string }).html_url;
  },
  async addDeployKey(token, owner, repo, publicKey) {
    const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/keys`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json" },
      body: JSON.stringify({ title: "sfo Sprite", key: publicKey, read_only: false }),
    });
    if (!r.ok) throw new Error(`GitHub would not add a deploy key to ${repo} (${r.status}): ${(await r.text()).slice(0, 200)}`);
  },
};

/** Captures an idea on a new Sprite of its own and records where it lives. */
export async function newCloudProject(
  idea: string,
  opts: { budget?: string; run: boolean },
  profile: Profile,
  deps: CloudDeps,
): Promise<string> {
  const env = deps.env ?? process.env;
  const readKeyWith = deps.readKeyWith ?? readKey;
  const log = deps.log ?? console.log;
  const credentials = credentialsFor(profile, env, readKeyWith);
  const githubToken = profile.githubToken ? readKeyWith(profile.githubToken, env) : null;
  if (profile.githubToken && !githubToken) throw new Error("your GitHub token was not found — fix it, or `sfo profile set github none`");

  const sprite = `sfo-${randomBytes(4).toString("hex")}`;
  log(`creating Sprite ${sprite} and setting it up (about a minute)`);
  deps.cli.create(sprite);
  let id: string | null = null;
  let triage = "";
  try {
    const setup = deps.cli.exec(sprite, SETUP, [process.env.SFO_REPO_URL || SFO_REPO, remoteProfile(profile, credentials.map((c) => c.method))]);
    if (setup.status !== 0) throw new Error(`setting up ${sprite} failed: ${setup.stdout.trim().split("\n").slice(-3).join(" ")}`);
    for (const c of credentials) {
      if (deps.cli.exec(sprite, STORE_SECRET, [c.file], { input: c.value }).status !== 0) throw new Error(`could not store the credential on ${sprite}`);
    }
    // Where `sfo new` on the Sprite snapshots them from, as it would here.
    const preferences = readPreferences(env);
    if (preferences?.trim() && deps.cli.exec(sprite, `cat > ~/.sfo/PREFERENCES.md`, [], { input: preferences }).status !== 0) {
      throw new Error(`could not copy your preferences to ${sprite}`);
    }

    // On its own Sprite the project is local; without --local, sfo there would
    // try to make yet another Sprite.
    const captured = deps.cli.exec(sprite, `cd ~ && exec sfo new "$@"`, [idea, "--local", "--no-run", ...(opts.budget ? ["--budget", opts.budget] : [])]);
    triage = captured.stdout;
    log(captured.stdout.trim().replace(/not started — `sfo run [^`]+` when you are ready\n?/, ""));
    id = captured.stdout.match(/^captured: (\S+)/m)?.[1] ?? null;
    if (captured.status !== 0 || !id) throw new Error("capture failed on the Sprite");
  } catch (err) {
    // Nothing on it is worth keeping yet, and nothing else would ever remove it.
    deps.cli.destroy(sprite);
    throw err;
  }

  let repo: string | null = null;
  if (githubToken) {
    try {
      repo = await connectRepo(id, sprite, githubToken, deps);
      log(`private repo: ${repo}`);
    } catch (err) {
      log(`no GitHub repo for this project — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  saveEntry(id, { sprite, repo, createdAt: new Date().toISOString(), summary: null }, env);

  // Starting what triage called out of scope spends money on something it
  // just said this cannot build; the person decides with `sfo run`.
  if (opts.run && !/triage: out of scope/.test(triage)) {
    deps.cli.exec(sprite, `exec sfo run "$1"`, [id]);
    log(`started on ${sprite} — \`sfo status\` to follow it`);
  }
  refreshCloud(id, deps);
  return id;
}

/**
 * Creates the project's private repo and lets its Sprite push to it. The
 * person's token never leaves this machine: everything on a Sprite is readable
 * by the agents that run there, and that token reaches every repo they own.
 * The Sprite instead makes a key of its own, allowed to push to this repo and
 * nothing else.
 */
async function connectRepo(id: string, sprite: string, token: string, deps: CloudDeps): Promise<string> {
  const gh = deps.github ?? github;
  const owner = await gh.login(token);
  const page = await gh.createPrivateRepo(token, id, "Built by sfo");
  const keygen = `set -e; mkdir -p ~/.ssh; chmod 700 ~/.ssh; rm -f ~/.ssh/sfo_deploy ~/.ssh/sfo_deploy.pub
ssh-keygen -q -t ed25519 -N "" -C "sfo $1" -f ~/.ssh/sfo_deploy; cat ~/.ssh/sfo_deploy.pub`;
  const made = deps.cli.exec(sprite, keygen, [id]);
  if (made.status !== 0) throw new Error("could not make a deploy key on the Sprite");
  await gh.addDeployKey(token, owner, id, made.stdout.trim());
  const wire = `cd ~/.sfo/"$1" && git remote add origin "$2" \
  && git config core.sshCommand "ssh -i ~/.ssh/sfo_deploy -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new" \
  && git push -q -u origin HEAD`;
  if (deps.cli.exec(sprite, wire, [id, `git@github.com:${owner}/${id}.git`]).status !== 0) throw new Error("could not push to the new repo");
  return page;
}

/** Runs an sfo command on the project's Sprite, attached to this terminal. */
export function forward(id: string, argv: string[], deps: CloudDeps): number {
  const entry = cloudEntry(id, deps.env);
  if (!entry) throw new Error(`${id} is not a cloud project`);
  const { status } = deps.cli.exec(entry.sprite, `exec sfo "$@"`, argv, { attach: true });
  refreshCloud(id, deps);
  return status;
}

/** Asks the project's Sprite how the project is doing, and remembers the answer. */
export function refreshCloud(id: string, deps: CloudDeps): CloudSummary | null {
  const entry = cloudEntry(id, deps.env);
  if (!entry) return null;
  const r = deps.cli.exec(entry.sprite, `exec sfo status --json`);
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
export function cloudSummaries(deps: CloudDeps): CloudSummary[] {
  const all = readCloud(deps.env);
  return Object.entries(all).flatMap(([id, entry]) => {
    const summary = !entry.summary || entry.summary.status === "running" ? refreshCloud(id, deps) : entry.summary;
    if (!summary) return [];
    // The label status would have shown, then where: a note replaces the
    // label, so "on sfo-…" alone would hide that it is running.
    const label = summary.note ?? (summary.status === "awaiting_human" ? "needs you" : summary.status);
    return [{ ...summary, note: `${label} · on ${entry.sprite}` }];
  });
}

/**
 * Brings a cloud project to this machine — for checks that need hardware it
 * has — as a git copy in the usual place. The Sprite stays the original.
 */
export function pullProject(id: string, deps: CloudDeps): string {
  const entry = cloudEntry(id, deps.env);
  if (!entry) throw new Error(`${id} is not a cloud project`);
  const remote = `/tmp/sfo-${id}.bundle`;
  const made = deps.cli.exec(entry.sprite, `cd ~/.sfo/"$1" && git bundle create -q "$2" --all`, [id, remote]);
  if (made.status !== 0) throw new Error(`could not bundle ${id} on ${entry.sprite}`);
  const local = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sfo-pull-")), `${id}.bundle`);
  deps.cli.pull(entry.sprite, remote, local);
  const dir = projectDir(id, deps.env);
  if (fs.existsSync(path.join(dir, ".git"))) {
    execFileSync("git", [...NO_INTERFERENCE, "pull", "-q", "--ff-only", local, "HEAD"], { cwd: dir, stdio: "pipe" });
  } else {
    execFileSync("git", [...NO_INTERFERENCE, "clone", "-q", local, dir], { stdio: "pipe" });
  }
  return dir;
}

/** Sends what was done to the local copy (check results) back to the Sprite. */
export function pushProjectBack(id: string, deps: CloudDeps): void {
  const entry = cloudEntry(id, deps.env);
  if (!entry) throw new Error(`${id} is not a cloud project`);
  commitStage(id, "check", deps.env);
  const local = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sfo-push-")), `${id}.bundle`);
  execFileSync("git", [...NO_INTERFERENCE, "bundle", "create", "-q", local, "HEAD"], { cwd: projectDir(id, deps.env), stdio: "pipe" });
  const remote = `/tmp/sfo-${id}-back.bundle`;
  deps.cli.push(entry.sprite, local, remote);
  const merged = deps.cli.exec(entry.sprite, `cd ~/.sfo/"$1" && git pull -q --ff-only "$2" HEAD`, [id, remote]);
  if (merged.status !== 0) throw new Error(`could not bring the check results back to ${entry.sprite}: ${merged.stdout.trim()}`);
  refreshCloud(id, deps);
}

/** Deletes the project's Sprite, and everything on it. Its repo, if any, remains. */
export function destroyCloudProject(id: string, deps: CloudDeps): CloudEntry {
  const entry = cloudEntry(id, deps.env);
  if (!entry) throw new Error(`${id} is not a cloud project`);
  deps.cli.destroy(entry.sprite);
  saveEntry(id, null, deps.env);
  return entry;
}
