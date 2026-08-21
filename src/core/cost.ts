import fs from "node:fs";
import { artifactPath, sfoDir, type Env } from "./paths.js";
import type { StageUsage } from "../runner/types.js";

export const COST_FILE = "COST.jsonl";

/**
 * Which route the model call took. Declared here rather than imported from the
 * triage stage to keep core independent of the stages above it; the two are
 * the same pair of strings on purpose.
 */
export type CostVia = "sdk" | "cli";

export interface CostRecord {
  stage: string;
  /** ISO timestamp of when the run finished. */
  at: string;
  ok: boolean;
  /** Absent in records written before the SDK path existed; read as "cli". */
  via: CostVia;
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

/**
 * `via` is deliberately not required. Records written before the SDK path
 * existed have no such field, and dropping them would erase spend that really
 * happened — a silent under-report, which is the worse failure. Anything that
 * is not exactly "sdk" reads as "cli", the only route those records could
 * have taken.
 */
function parseCostRecord(value: unknown): CostRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.stage !== "string" || typeof rec.at !== "string") return null;
  if (typeof rec.usage !== "object" || rec.usage === null) return null;
  const usage = rec.usage as Record<string, unknown>;
  if (!USAGE_FIELDS.every((f) => typeof usage[f] === "number")) return null;

  return {
    stage: rec.stage,
    at: rec.at,
    ok: rec.ok === true,
    via: rec.via === "sdk" ? "sdk" : "cli",
    usage: usage as unknown as StageUsage,
  };
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
  // Defaults to "cli" because every spawned stage runs through the claude
  // binary; only triage can currently take the SDK route.
  via: CostVia = "cli",
): void {
  if (!usage) return;
  const record: CostRecord = { stage, at: new Date().toISOString(), ok, via, usage };
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
      const parsed = parseCostRecord(JSON.parse(trimmed) as unknown);
      if (parsed) out.push(parsed);
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
