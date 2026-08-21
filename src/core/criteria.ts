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

/**
 * Enforced on read as well as write. Three Phase 2 stages — `plan`,
 * `test-write` and `review` — call readCriteria directly, and each keys by id.
 * A duplicate introduced by a hand edit or a malformed stage output would
 * silently drop one criterion from whatever consumes them, shrinking the
 * contract the build is held to. Validating only on write catches it solely
 * when something happens to rewrite the file.
 */
function assertUniqueIds(criteria: Criterion[]): void {
  const seen = new Set<string>();
  for (const c of criteria) {
    if (seen.has(c.id)) throw new Error(`duplicate criterion id: ${c.id}`);
    seen.add(c.id);
  }
}

export function readCriteria(id: string, env?: Env): Criterion[] {
  const criteria = readRecords(artifactPath(id, CRITERIA_FILE, env), CriterionSchema);
  assertUniqueIds(criteria);
  return criteria;
}

export function writeCriteria(id: string, criteria: Criterion[], env?: Env): void {
  assertUniqueIds(criteria);
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
