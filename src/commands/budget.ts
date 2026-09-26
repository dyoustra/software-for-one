import { readState } from "../core/state.js";
import { budgetState, writeBudget, clearBudget, formatBudget } from "../core/budget.js";
import type { Env } from "../core/paths.js";

/**
 * Parsed before anything is spent. `sfo new --budget oops` must fail while it
 * is still free, not after triage has already been paid for; and commander
 * hands options through as strings, so `Number` is the only thing between a
 * typo and a ceiling of NaN that never binds.
 */
export function parseBudget(raw: string): number {
  const usd = Number(raw);
  if (!Number.isFinite(usd) || usd <= 0) {
    throw new Error(`budget must be a positive dollar amount, got "${raw}"`);
  }
  return usd;
}

export function showBudget(id: string, env?: Env): void {
  // Reading state first so an unknown id reports "no such project" rather than
  // "no ceiling set".
  readState(id, env);
  const state = budgetState(id, env);
  console.log(
    state ? formatBudget(state) : `no ceiling set — \`sfo budget ${id} <usd>\` to set one`,
  );
}

/**
 * The way out of a budget park. Without it the ceiling is a trap: the
 * orchestrator refuses to run, and the only remedy is hand-editing the
 * project's BUDGET.json.
 */
export function setBudget(id: string, raw: string, env?: Env): void {
  readState(id, env);
  if (raw === "none") {
    console.log(clearBudget(id, env) ? `ceiling removed for ${id}` : `${id} had no ceiling`);
    return;
  }
  writeBudget(id, parseBudget(raw), env);
  const state = budgetState(id, env);
  if (state) console.log(formatBudget(state));
}
