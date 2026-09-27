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

function readBudgetFile(id: string, env?: Env): BudgetFile | null {
  const file = artifactPath(id, BUDGET_FILE, env);
  if (!fs.existsSync(file)) return null;
  let parsed: { ceilingUsd?: unknown; billedOnly?: unknown };
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8")) as typeof parsed;
  } catch {
    throw new Error(`${BUDGET_FILE} is not valid JSON`);
  }
  if (typeof parsed.ceilingUsd !== "number") return null;
  return { ceilingUsd: parsed.ceilingUsd, billedOnly: parsed.billedOnly === true };
}

export function readBudget(id: string, env?: Env): number | null {
  return readBudgetFile(id, env)?.ceilingUsd ?? null;
}

export function writeBudget(id: string, ceilingUsd: number, env?: Env, billedOnly = false): void {
  if (!(ceilingUsd > 0)) throw new Error("budget ceiling must be positive");
  fs.mkdirSync(sfoDir(id, env), { recursive: true });
  fs.writeFileSync(
    artifactPath(id, BUDGET_FILE, env),
    `${JSON.stringify({ ceilingUsd, ...(billedOnly ? { billedOnly } : {}) }, null, 2)}\n`,
  );
}

/** Removes the ceiling. Returns whether there was one to remove. */
export function clearBudget(id: string, env?: Env): boolean {
  const file = artifactPath(id, BUDGET_FILE, env);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file);
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
