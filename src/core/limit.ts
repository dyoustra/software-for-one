import fs from "node:fs";
import { artifactPath, sfoDir, type Env } from "./paths.js";
import type { UsageLimit } from "../runner/types.js";

export const LIMIT_FILE = "LIMIT.json";

export interface LimitPark extends UsageLimit {
  /** The stage the limit stopped, which is the one a resumed run repeats. */
  stage: string;
  at: string;
}

/**
 * Why a project is parked on a plan limit. A file rather than a state field
 * for the reason the budget note derives from files: the listing reads it,
 * and the next run clears it simply by starting.
 */
export function writeLimit(id: string, park: LimitPark, env?: Env): void {
  fs.mkdirSync(sfoDir(id, env), { recursive: true });
  fs.writeFileSync(artifactPath(id, LIMIT_FILE, env), `${JSON.stringify(park, null, 2)}\n`);
}

export function readLimit(id: string, env?: Env): LimitPark | null {
  try {
    return JSON.parse(fs.readFileSync(artifactPath(id, LIMIT_FILE, env), "utf8")) as LimitPark;
  } catch {
    return null;
  }
}

export function clearLimit(id: string, env?: Env): void {
  fs.rmSync(artifactPath(id, LIMIT_FILE, env), { force: true });
}

export function formatLimit(id: string, park: LimitPark): string {
  const when = park.resetsAt ? ` — resets ${new Date(park.resetsAt).toLocaleString()}` : "";
  return `plan limit reached at ${park.stage}${when}; \`sfo run ${id}\` then, or \`sfo run ${id} --use-api-key\` now`;
}
