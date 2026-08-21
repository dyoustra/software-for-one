import { readCostRecords, totalCost, type CostRecord } from "../core/cost.js";
import { readState } from "../core/state.js";
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

const PROJECT_ALIGN: Align[] = ["l", "r", "r", "r", "r", "r", "r", "r"];

function usageCells(records: CostRecord[]): string[] {
  const t = totalCost(records);
  return [
    String(records.length),
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
    ["STAGE", "RUNS", "COST $", "IN", "OUT", "CACHE W", "CACHE R", "TIME"],
    rows,
    PROJECT_ALIGN,
  );
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
    ["PROJECT", "RUNS", "COST $", "IN", "OUT", "CACHE W", "CACHE R", "TIME"],
    rows,
    PROJECT_ALIGN,
  );
}

export function showCost(id: string | undefined, env?: Env): void {
  if (id !== undefined) {
    // Reading state first so an unknown id reports "no such project" instead of
    // quietly showing an empty bill.
    readState(id, env);
    console.log(formatProjectCost(readCostRecords(id, env)));
    return;
  }

  console.log(
    formatAllCosts(
      listProjects(env).map((p) => ({ id: p.id, records: readCostRecords(p.id, env) })),
    ),
  );
}
