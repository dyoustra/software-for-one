import { readCriteria, groupCriteria, type Criterion } from "../core/criteria.js";
import { readState } from "../core/state.js";
import type { Env } from "../core/paths.js";

export function formatCriteria(criteria: Criterion[]): string {
  if (criteria.length === 0) return "no criteria yet — has the spec stage run?";

  const groups = groupCriteria(criteria);
  const lines: string[] = [];
  for (const [group, items] of groups) {
    lines.push(`\n${group}`);
    for (const c of items) lines.push(`  ${c.id.padEnd(8)} ${c.text}`);
  }
  lines.push(`\n${criteria.length} criteria in ${groups.size} groups`);
  return lines.join("\n");
}

export function showCriteria(id: string, env?: Env): void {
  // Reading state first so an unknown id reports "no such project" instead of
  // quietly showing an empty list.
  readState(id, env);
  console.log(formatCriteria(readCriteria(id, env)));
}
