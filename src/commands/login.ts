import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { projectsRoot, type Env } from "../core/paths.js";

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
    fs.mkdirSync(projectsRoot(env), { recursive: true });
    fs.writeFileSync(path.join(projectsRoot(env), "control.json"), `${JSON.stringify({ url: base }, null, 2)}\n`);
    log(`signed in to ${base}`);
    return;
  }
}

export async function logout(env: Env = process.env): Promise<string> {
  const token = readControlToken();
  if (!token) return "not signed in";
  await request(`${controlUrl(env)}/devices/current`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } }).catch(() => null);
  spawnSync("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE], { stdio: "ignore" });
  return "signed out, and this device's token revoked";
}
