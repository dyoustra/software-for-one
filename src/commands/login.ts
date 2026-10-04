import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { projectsRoot, type Env } from "../core/paths.js";
import { readProfile, readKey, describeKeyRef, type KeyRef } from "../core/access.js";

const KEYCHAIN_SERVICE = "sfo-control";
export const DEFAULT_CONTROL_URL = "https://sfo-control.fly.dev";

/** Where the control plane is: SFO_CONTROL_URL, else what `sfo login` recorded, else the default. */
export function controlUrl(env: Env = process.env): string {
  if (env.SFO_CONTROL_URL) return env.SFO_CONTROL_URL;
  try {
    return (JSON.parse(fs.readFileSync(path.join(projectsRoot(env), "control.json"), "utf8")) as { url: string }).url;
  } catch {
    return DEFAULT_CONTROL_URL;
  }
}

type ControlFile = { url?: string; githubFingerprint?: string | null };

function readControlFile(env: Env): ControlFile {
  try {
    return JSON.parse(fs.readFileSync(path.join(projectsRoot(env), "control.json"), "utf8")) as ControlFile;
  } catch {
    return {};
  }
}

function writeControlFile(file: ControlFile, env: Env): void {
  fs.mkdirSync(projectsRoot(env), { recursive: true });
  fs.writeFileSync(path.join(projectsRoot(env), "control.json"), `${JSON.stringify(file, null, 2)}\n`);
}

export function readControlToken(): string | null {
  try {
    return execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

/** Into the Keychain through `security -i` on stdin, so the token is never a process argument. */
function storeControlToken(token: string): void {
  const r = spawnSync("security", ["-i"], { input: `add-generic-password -U -a sfo -s ${KEYCHAIN_SERVICE} -w ${token}\n`, encoding: "utf8" });
  if (r.status !== 0 || !readControlToken()) throw new Error(`could not save the token to your Keychain: ${r.stderr.trim()}`);
}

async function request(url: string, init: RequestInit = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, init);
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

/**
 * Signs this machine in to the control plane: shows a code, opens the page to
 * approve it, and waits — on a request the server holds open — for the token.
 */
export async function login(env: Env = process.env, log: (m: string) => void = console.log): Promise<void> {
  const base = controlUrl(env);
  if (readControlToken() && (await authed("/devices", {}, env).catch(() => ({ status: 0 }))).status === 200) {
    log(`already signed in to ${base}`);
    await offerCredentials(env, log);
    await importCloudProjects(env, log);
    return;
  }
  const started = await request(`${base}/auth/device`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: os.hostname().replace(/\.local$/, "") }),
  });
  if (started.status !== 200) throw new Error(`the control plane at ${base} did not start a sign-in (${started.status})`);
  const { deviceCode, userCode, verifyUrl } = started.body as { deviceCode: string; userCode: string; verifyUrl: string };

  log(`Your code: ${userCode}\nType it at ${verifyUrl} (opening it now) and approve`);
  if (process.platform === "darwin") spawnSync("open", [verifyUrl], { stdio: "ignore" });

  for (;;) {
    // A restart of the control plane (a deploy, a new secret) drops the held
    // request; the code survives it, so ask again.
    const r = await request(`${base}/auth/device/${deviceCode}`).catch(() => null);
    if (r === null || r.status === 202 || r.status >= 500) {
      if (r === null || r.status >= 500) await new Promise((done) => setTimeout(done, 2000));
      continue;
    }
    if (r.status !== 200) throw new Error(String(r.body.error ?? `sign-in failed (${r.status})`));
    storeControlToken(String(r.body.token));
    writeControlFile({ ...readControlFile(env), url: base }, env);
    log(`signed in to ${base}`);
    await offerCredentials(env, log);
    await importCloudProjects(env, log);
    return;
  }
}

async function confirm(question: string): Promise<boolean> {
  // With no terminal there is no one to say yes, and readline at end of input
  // never answers: Node would exit mid-command.
  if (!process.stdin.isTTY) {
    console.log(`${question} [y/N] — no terminal, so no`);
    return false;
  }
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

export async function authed(path: string, init: RequestInit = {}, env: Env = process.env): Promise<{ status: number; body: Record<string, unknown> }> {
  const token = readControlToken();
  if (!token) throw new Error("not signed in — `sfo login`");
  return request(`${controlUrl(env)}${path}`, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
}

/**
 * Carries this machine's credentials up, so cloud projects started anywhere
 * can use them: the Claude token the profile names for the cloud, and the API
 * key only where the profile would use it. Each is named and asked about first.
 */
export async function offerCredentials(env: Env = process.env, log: (m: string) => void = console.log): Promise<void> {
  const profile = readProfile(env);
  if (!profile) return;
  const have = ((await authed("/credentials", {}, env)).body.have ?? []) as string[];
  const offers: [string, string, KeyRef | null, boolean][] = [
    ["claude", "claude_token", profile.subscriptionToken, profile.modelAccess.includes("claude_subscription")],
    ["api-key", "anthropic_api_key", profile.apiKey, profile.sfoPrefers === "anthropic_api_key" || profile.fallbackToApiKey],
  ];
  for (const [path, kind, ref, wanted] of offers) {
    if (!ref || !wanted || have.includes(kind)) continue;
    const value = readKey(ref, env);
    if (!value) continue;
    if (!(await confirm(`Upload your ${kind === "claude_token" ? "Claude token" : "API key"} (${describeKeyRef(ref)}), stored encrypted, for cloud projects?`))) continue;
    const r = await authed(`/credentials/${path}`, { method: "PUT", body: JSON.stringify({ value }) }, env);
    log(r.status === 200 ? `uploaded ${describeKeyRef(ref)}` : `not uploaded: ${String(r.body.error)}`);
  }
  // A GitHub App cannot create repositories in a personal account, so cloud
  // projects' repos are made with the person's own fine-grained token.
  const gh = profile.githubToken ? readKey(profile.githubToken, env) : null;
  // Asked once per token: a hash of the last one uploaded is kept, never the token.
  const fingerprint = gh ? createHash("sha256").update(gh).digest("hex") : null;
  const control = readControlFile(env);
  if (profile.githubToken && gh && control.githubFingerprint !== fingerprint) {
    const question = have.includes("github_installation")
      ? `Use your GitHub token (${describeKeyRef(profile.githubToken)}) for cloud projects' repos, replacing the GitHub connection stored now?`
      : `Upload your GitHub token (${describeKeyRef(profile.githubToken)}), stored encrypted, so cloud projects get a private repo?`;
    if (await confirm(question)) {
      const r = await authed("/credentials/github", { method: "PUT", body: JSON.stringify({ accessToken: gh }) }, env);
      log(r.status === 200 ? `GitHub: repos will be made as ${String(r.body.login)}` : `not uploaded: ${String(r.body.error)}`);
      if (r.status === 200) writeControlFile({ ...readControlFile(env), githubFingerprint: fingerprint }, env);
    }
  } else if (!have.includes("github_installation")) {
    log("no GitHub token — cloud projects get no repo. To give them one: a fine-grained token with Administration read/write, `sfo profile set github keychain:<service>`, then `sfo login`");
  }
}

/**
 * Moves projects this machine started on Sprites directly onto the control
 * plane. The control plane can reach every Sprite in the organization, so it
 * asks for proof: a one-time challenge written onto the Sprite with this
 * machine's own Sprites access.
 */
export async function importCloudProjects(env: Env = process.env, log: (m: string) => void = console.log): Promise<void> {
  const { readCloud, forgetEntry } = await import("../core/cloud.js");
  const entries = Object.entries(readCloud(env));
  if (entries.length === 0) return;
  const { spriteCli } = await import("../core/sprite.js");
  for (const [id, entry] of entries) {
    const ch = await authed("/projects/import/challenge", { method: "POST", body: JSON.stringify({ id, sprite: entry.sprite }) }, env);
    if (ch.status === 409) {
      // Claimed is not the same as claimed by you: forget the local record only
      // once the control plane shows the project under this account.
      const mine = await authed(`/projects/${id}`, {}, env);
      if (mine.status === 200 && mine.body.sprite === entry.sprite) {
        forgetEntry(id, env);
        log(`${id} is already on the control plane`);
      } else {
        log(`${id} or its Sprite ${entry.sprite} is claimed by another account on the control plane — kept here; it may not be yours any more`);
      }
      continue;
    }
    if (ch.status !== 200) {
      log(`${id} not moved: ${String(ch.body.error)}`);
      continue;
    }
    const wrote = await spriteCli.exec(entry.sprite, `cat > ~/.sfo/"$1"/.sfo/import-proof`, [id], { input: String(ch.body.nonce) }).catch(() => null);
    if (!wrote || wrote.status !== 0) {
      log(`${id} not moved: could not reach ${entry.sprite} with your Sprites access`);
      continue;
    }
    const done = await authed("/projects/import", { method: "POST", body: JSON.stringify({ nonce: ch.body.nonce, repo: entry.repo }) }, env);
    if (done.status === 200) {
      forgetEntry(id, env);
      log(`moved ${id} to the control plane`);
    } else {
      log(`${id} not moved: ${String(done.body.error)}`);
    }
  }
}

export async function logout(env: Env = process.env): Promise<string> {
  const token = readControlToken();
  if (!token) return "not signed in";
  await request(`${controlUrl(env)}/devices/current`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } }).catch(() => null);
  spawnSync("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE], { stdio: "ignore" });
  return "signed out, and this device's token revoked";
}
