import { readDecisions, type Decision } from "../core/decisions.js";
import { readState } from "../core/state.js";
import type { Env } from "../core/paths.js";

const RADIUS_ORDER: Record<Decision["blast_radius"], number> = {
  external: 0,
  structural: 1,
  local: 2,
};

export function formatDecisions(decisions: Decision[]): string {
  if (decisions.length === 0) return "no decisions recorded yet";

  // Expensive-to-reverse calls lead. Buried among forty local decisions, a
  // structural one goes unread, which defeats the point of recording it.
  const sorted = [...decisions].sort(
    (a, b) => RADIUS_ORDER[a.blast_radius] - RADIUS_ORDER[b.blast_radius],
  );

  return sorted
    .map((d) =>
      [
        `${d.id}  [${d.blast_radius}]  decided by ${d.decided_by}`,
        `  ${d.decision}`,
        `  chose: ${d.chose}`,
        `  why:   ${d.why}`,
      ].join("\n"),
    )
    .join("\n\n");
}

export function showDecisions(id: string, env?: Env): void {
  // Reading state first so an unknown id reports "no such project" instead of
  // quietly showing an empty list.
  readState(id, env);
  console.log(formatDecisions(readDecisions(id, env)));
}
