import fs from "node:fs";
import { artifactPath, sfoDir, type Env } from "./paths.js";

export const RETRY_FILE = "RETRY.json";

/**
 * What a retry is for. Written by `sfo retry`, read by smoke and review so
 * they redo only what failed, and cleared when deliver completes.
 */
export interface Retry {
  slices: string[];
  seams: string[];
  findings: string[];
  at: string;
}

export function writeRetry(id: string, retry: Retry, env?: Env): void {
  fs.mkdirSync(sfoDir(id, env), { recursive: true });
  fs.writeFileSync(artifactPath(id, RETRY_FILE, env), `${JSON.stringify(retry, null, 2)}\n`);
}

export function readRetry(id: string, env?: Env): Retry | null {
  try {
    return JSON.parse(fs.readFileSync(artifactPath(id, RETRY_FILE, env), "utf8")) as Retry;
  } catch {
    return null;
  }
}

export function clearRetry(id: string, env?: Env): void {
  fs.rmSync(artifactPath(id, RETRY_FILE, env), { force: true });
}
