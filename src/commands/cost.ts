import { readCostRecords, totalCost, spendByBilling, type CostRecord } from "../core/cost.js";
import { readState } from "../core/state.js";
import { budgetState, formatBudget } from "../core/budget.js";
import { listProjects } from "./status.js";
import type { Env } from "../core/paths.js";

const money = (n: number): string => n.toFixed(4);
const tokens = (n: number): string => n.toLocaleString("en-US");
const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

type Align = "l" | "r";

function table(header: string[], rows: string[][], aligns: Align[]): string {
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i]?.length ?? 0)),
  );
  const line = (cells: string[]): string =>
    cells
      .map((c, i) => (aligns[i] === "r" ? c.padStart(widths[i]) : c.padEnd(widths[i])))
      .join("  ")
      .trimEnd();
  return [line(header), ...rows.map(line)].join("\n");
}

const PROJECT_ALIGN: Align[] = ["l", "r", "l", "r", "r", "r", "r", "r", "r"];

/**
 * Both routes when a stage ran on each, because the two are not the same
 * request: the CLI path loads tools and CLAUDE.md the SDK path never sees, so
 * a mixed row is worth showing rather than collapsing to whichever ran last.
 */
function viaCell(records: CostRecord[]): string {
  const seen = [...new Set(records.map((r) => r.via))].sort();
  return seen.length === 0 ? "-" : seen.join("+");
}

function usageCells(records: CostRecord[]): string[] {
  const t = totalCost(records);
  return [
    String(records.length),
    viaCell(records),
    money(t.costUsd),
    tokens(t.inputTokens),
    tokens(t.outputTokens),
    tokens(t.cacheCreationInputTokens),
    tokens(t.cacheReadInputTokens),
    seconds(t.durationMs),
  ];
}

/**
 * One row per stage rather than per record: retries are summed into the stage
 * they belong to, with the RUNS column left as the evidence that a stage was
 * paid for more than once.
 */
export function formatProjectCost(records: CostRecord[]): string {
  if (records.length === 0) return "no cost recorded yet";

  const byStage = new Map<string, CostRecord[]>();
  for (const r of records) {
    const bucket = byStage.get(r.stage);
    if (bucket) bucket.push(r);
    else byStage.set(r.stage, [r]);
  }

  const rows = [...byStage].map(([stage, rs]) => [stage, ...usageCells(rs)]);
  rows.push(["TOTAL", ...usageCells(records)]);

  return table(
    ["STAGE", "RUNS", "VIA", "COST $", "IN", "OUT", "CACHE W", "CACHE R", "TIME"],
    rows,
    PROJECT_ALIGN,
  );
}

/**
 * The table's COST column adds money that was charged to money that was not:
 * on a subscription, `claude` reports what the run would have cost at API
 * prices. Null when nothing ran on a plan, since then the total means what it
 * says.
 */
export function formatBillingSplit(records: CostRecord[]): string | null {
  const split = spendByBilling(records);
  if (split.plan === 0) return null;
  const parts = [`$${split.api.toFixed(2)} billed`, `$${split.plan.toFixed(2)} API-equivalent on your plan`];
  if (split.unknown > 0) parts.push(`$${split.unknown.toFixed(2)} unlabeled (from before billing was recorded)`);
  return parts.join(" · ");
}

export interface ProjectCost {
  id: string;
  records: CostRecord[];
}

export function formatAllCosts(projects: ProjectCost[]): string {
  if (projects.length === 0) return "no projects yet — try `sfo new`";

  const rows = projects.map((p) => [p.id, ...usageCells(p.records)]);
  rows.push(["TOTAL", ...usageCells(projects.flatMap((p) => p.records))]);

  return table(
    ["PROJECT", "RUNS", "VIA", "COST $", "IN", "OUT", "CACHE W", "CACHE R", "TIME"],
    rows,
    PROJECT_ALIGN,
  );
}

export function showCost(id: string | undefined, env?: Env): void {
  if (id !== undefined) {
    // Reading state first so an unknown id reports "no such project" instead of
    // quietly showing an empty bill.
    readState(id, env);
    const records = readCostRecords(id, env);
    console.log(formatProjectCost(records));
    const split = formatBillingSplit(records);
    if (split) console.log(`\n${split}`);
    const budget = budgetState(id, env);
    if (budget) console.log(`\n${formatBudget(budget)}`);
    return;
  }

  const projects = listProjects(env).map((p) => ({ id: p.id, records: readCostRecords(p.id, env) }));
  console.log(formatAllCosts(projects));
  const split = formatBillingSplit(projects.flatMap((p) => p.records));
  if (split) console.log(`\n${split}`);
}
