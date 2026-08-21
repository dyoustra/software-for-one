import fs from "node:fs";
import { artifactPath, sfoDir, type Env } from "./paths.js";
import type { StageUsage } from "../runner/types.js";

export const COST_FILE = "COST.jsonl";

export interface CostRecord {
  stage: string;
  /** ISO timestamp of when the run finished. */
  at: string;
  ok: boolean;
  usage: StageUsage;
}

const USAGE_FIELDS = [
  "costUsd",
  "durationMs",
  "numTurns",
  "inputTokens",
  "outputTokens",
  "cacheCreationInputTokens",
  "cacheReadInputTokens",
] as const;

function isCostRecord(value: unknown): value is CostRecord {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as Record<string, unknown>;
  if (typeof rec.stage !== "string" || typeof rec.at !== "string") return false;
  if (typeof rec.usage !== "object" || rec.usage === null) return false;
  const usage = rec.usage as Record<string, unknown>;
  return USAGE_FIELDS.every((f) => typeof usage[f] === "number");
}

/**
 * Appends one line per stage run. Deliberately never rewrites or deduplicates:
 * retries and `sfo stage` re-runs each spent real money, so the file has to
 * show total spend rather than the cost of the path that happened to succeed.
 */
export function recordCost(
  id: string,
  stage: string,
  ok: boolean,
  usage: StageUsage | undefined,
  env?: Env,
): void {
  if (!usage) return;
  const record: CostRecord = { stage, at: new Date().toISOString(), ok, usage };
  fs.mkdirSync(sfoDir(id, env), { recursive: true });
  fs.appendFileSync(artifactPath(id, COST_FILE, env), `${JSON.stringify(record)}\n`);
}

export function readCostRecords(id: string, env?: Env): CostRecord[] {
  const file = artifactPath(id, COST_FILE, env);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }

  const out: CostRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      // A run killed mid-append leaves a truncated final line. One bad line
      // must not cost the user visibility into everything before it.
      const parsed: unknown = JSON.parse(trimmed);
      if (isCostRecord(parsed)) out.push(parsed);
    } catch {
      // Not JSON; skip.
    }
  }
  return out;
}

export function totalCost(records: CostRecord[]): StageUsage {
  const total: StageUsage = {
    costUsd: 0,
    durationMs: 0,
    numTurns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
  for (const r of records) {
    for (const f of USAGE_FIELDS) total[f] += r.usage[f];
  }
  return total;
}
