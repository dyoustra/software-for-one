import fs from "node:fs";
import { artifactPath, sfoDir, type Env } from "./paths.js";
import { readCostRecords, spendByBilling } from "./cost.js";

export const BUDGET_FILE = "BUDGET.json";

export interface BudgetState {
  ceiling: number;
  spent: number;
  remaining: number;
  exceeded: boolean;
  /** The ceiling counts only billed spend, not usage drawn from a plan. */
  billedOnly: boolean;
}

interface BudgetFile {
  ceilingUsd: number;
  billedOnly: boolean;
}

interface RawBudget {
  ceilingUsd?: unknown;
  billedOnly?: unknown;
  smokeCapUsd?: unknown;
}

function readRaw(id: string, env?: Env): RawBudget {
  const file = artifactPath(id, BUDGET_FILE, env);
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as RawBudget;
  } catch {
    throw new Error(`${BUDGET_FILE} is not valid JSON`);
  }
}

/** The ceiling and the smoke cap share a file; setting either keeps the other. */
function writeRaw(id: string, raw: RawBudget, env?: Env): void {
  const file = artifactPath(id, BUDGET_FILE, env);
  const kept = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined));
  if (Object.keys(kept).length === 0) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(sfoDir(id, env), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(kept, null, 2)}\n`);
}

function readBudgetFile(id: string, env?: Env): BudgetFile | null {
  const parsed = readRaw(id, env);
  if (typeof parsed.ceilingUsd !== "number") return null;
  return { ceilingUsd: parsed.ceilingUsd, billedOnly: parsed.billedOnly === true };
}

/** What one smoke run may spend on real calls, by the checks' declared costs. */
export const DEFAULT_SMOKE_CAP_USD = 2;

export function readSmokeCap(id: string, env?: Env): number {
  const raw = readRaw(id, env).smokeCapUsd;
  return typeof raw === "number" && raw >= 0 ? raw : DEFAULT_SMOKE_CAP_USD;
}

export function writeSmokeCap(id: string, capUsd: number, env?: Env): void {
  if (!(capUsd >= 0)) throw new Error("smoke cap must be zero or more");
  writeRaw(id, { ...readRaw(id, env), smokeCapUsd: capUsd }, env);
}

export function readBudget(id: string, env?: Env): number | null {
  return readBudgetFile(id, env)?.ceilingUsd ?? null;
}

export function writeBudget(id: string, ceilingUsd: number, env?: Env, billedOnly = false): void {
  if (!(ceilingUsd > 0)) throw new Error("budget ceiling must be positive");
  writeRaw(
    id,
    { ...readRaw(id, env), ceilingUsd, billedOnly: billedOnly ? true : undefined },
    env,
  );
}

/** Removes the ceiling. Returns whether there was one to remove. */
export function clearBudget(id: string, env?: Env): boolean {
  const raw = readRaw(id, env);
  if (typeof raw.ceilingUsd !== "number") return false;
  writeRaw(id, { ...raw, ceilingUsd: undefined, billedOnly: undefined }, env);
  return true;
}

/**
 * Spend counts every recorded run, including failed ones. A failed stage spent
 * real money; excluding it would let a project with repeated failures run past
 * its ceiling indefinitely — the exact case a ceiling exists for.
 *
 * A billed-only ceiling still counts unlabeled records: nobody knows whether
 * they were charged, and under-counting is the failure a ceiling cannot have.
 */
export function budgetState(id: string, env?: Env): BudgetState | null {
  const config = readBudgetFile(id, env);
  if (config === null) return null;

  const records = readCostRecords(id, env);
  const split = spendByBilling(records);
  const spent = config.billedOnly
    ? split.api + split.unknown
    : records.reduce((sum, r) => sum + r.usage.costUsd, 0);
  const ceiling = config.ceilingUsd;
  return {
    ceiling,
    spent,
    remaining: ceiling - spent,
    exceeded: spent >= ceiling,
    billedOnly: config.billedOnly,
  };
}

/** One line, shared by `sfo cost` and the budget park's explanation. */
export function formatBudget(state: BudgetState): string {
  const spent = state.billedOnly ? "billed" : "spent";
  return `budget: $${state.spent.toFixed(2)} ${spent} of a $${state.ceiling.toFixed(2)} ceiling ($${state.remaining.toFixed(2)} left)`;
}
