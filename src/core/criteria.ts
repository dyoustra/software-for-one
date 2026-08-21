import { z } from "zod";
import { artifactPath, type Env } from "./paths.js";
import { readRecords, writeRecords } from "./jsonl.js";

export const CriterionSchema = z.object({
  id: z.string().min(1),
  group: z.string().min(1),
  text: z.string().min(1),
  /** Assigned by Plan B's `plan` stage when it refines the spec's grouping. */
  slice: z.string().optional(),
});

export type Criterion = z.infer<typeof CriterionSchema>;

export const CRITERIA_FILE = "CRITERIA.jsonl";

export function readCriteria(id: string, env?: Env): Criterion[] {
  return readRecords(artifactPath(id, CRITERIA_FILE, env), CriterionSchema);
}

export function writeCriteria(id: string, criteria: Criterion[], env?: Env): void {
  const seen = new Set<string>();
  for (const c of criteria) {
    if (seen.has(c.id)) {
      // Downstream stages key on id. A duplicate silently drops one criterion
      // from whatever consumes them, shrinking the contract the build must meet.
      throw new Error(`duplicate criterion id: ${c.id}`);
    }
    seen.add(c.id);
  }
  writeRecords(artifactPath(id, CRITERIA_FILE, env), CriterionSchema, criteria);
}

/** First-seen order, so the spec stage's sequence survives. */
export function groupCriteria(criteria: Criterion[]): Map<string, Criterion[]> {
  const groups = new Map<string, Criterion[]>();
  for (const c of criteria) {
    const existing = groups.get(c.group);
    if (existing) existing.push(c);
    else groups.set(c.group, [c]);
  }
  return groups;
}
