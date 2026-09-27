import fs from "node:fs";
import { artifactPath, sfoDir, type Env } from "./paths.js";

export const STOPPED_FILE = "STOPPED.json";

/** That a person stopped the run, for `sfo status` to say so. Cleared when a run starts. */
export function writeStopped(id: string, stage: string, env?: Env): void {
  fs.mkdirSync(sfoDir(id, env), { recursive: true });
  fs.writeFileSync(artifactPath(id, STOPPED_FILE, env), `${JSON.stringify({ stage, at: new Date().toISOString() })}\n`);
}

export function isStopped(id: string, env?: Env): boolean {
  return fs.existsSync(artifactPath(id, STOPPED_FILE, env));
}

export function clearStopped(id: string, env?: Env): void {
  fs.rmSync(artifactPath(id, STOPPED_FILE, env), { force: true });
}
