import fs from "node:fs";
import { artifactPath, sfoDir, type Env } from "./paths.js";
import { readCostRecords } from "./cost.js";

export const BUDGET_FILE = "BUDGET.json";

export interface BudgetState {
  ceiling: number;
  spent: number;
  remaining: number;
  exceeded: boolean;
}

export function readBudget(id: string, env?: Env): number | null {
  const file = artifactPath(id, BUDGET_FILE, env);
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { ceilingUsd?: unknown };
  return typeof parsed.ceilingUsd === "number" ? parsed.ceilingUsd : null;
}

export function writeBudget(id: string, ceilingUsd: number, env?: Env): void {
  if (!(ceilingUsd > 0)) throw new Error("budget ceiling must be positive");
  fs.mkdirSync(sfoDir(id, env), { recursive: true });
  fs.writeFileSync(
    artifactPath(id, BUDGET_FILE, env),
    `${JSON.stringify({ ceilingUsd }, null, 2)}\n`,
  );
}

/**
 * Spend counts every recorded run, including failed ones. A failed stage spent
 * real money; excluding it would let a project with repeated failures run past
 * its ceiling indefinitely — the exact case a ceiling exists for.
 */
export function budgetState(id: string, env?: Env): BudgetState | null {
  const ceiling = readBudget(id, env);
  if (ceiling === null) return null;

  const spent = readCostRecords(id, env).reduce((sum, r) => sum + r.usage.costUsd, 0);
  return { ceiling, spent, remaining: ceiling - spent, exceeded: spent >= ceiling };
}

/** One line, shared by `sfo cost` and the budget park's explanation. */
export function formatBudget(state: BudgetState): string {
  return `budget: $${state.spent.toFixed(2)} spent of a $${state.ceiling.toFixed(2)} ceiling ($${state.remaining.toFixed(2)} left)`;
}
