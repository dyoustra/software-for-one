import { z } from "zod";
import { artifactPath, type Env } from "./paths.js";
import { readRecords, writeRecords } from "./jsonl.js";

export const SliceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  criterionIds: z.array(z.string().min(1)).min(1),
  prerequisites: z.array(z.string()),
});

export type Slice = z.infer<typeof SliceSchema>;
export const SLICES_FILE = "SLICES.jsonl";

function validate(slices: Slice[]): void {
  const ids = new Set<string>();
  for (const s of slices) {
    if (ids.has(s.id)) throw new Error(`duplicate slice id: ${s.id}`);
    if (s.criterionIds.length === 0) throw new Error(`slice ${s.id} has no criteria`);
    ids.add(s.id);
  }
  for (const s of slices) {
    for (const p of s.prerequisites) {
      if (!ids.has(p)) throw new Error(`slice ${s.id} has unknown prerequisite ${p}`);
    }
  }

  // A cycle would make nextRunnable loop forever with nothing runnable, which
  // reads as a stalled build rather than a malformed plan.
  const state = new Map<string, "visiting" | "done">();
  const byId = new Map(slices.map((s) => [s.id, s]));
  const walk = (id: string, trail: string[]): void => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "visiting") {
      throw new Error(`prerequisite cycle: ${[...trail, id].join(" -> ")}`);
    }
    state.set(id, "visiting");
    for (const p of byId.get(id)?.prerequisites ?? []) walk(p, [...trail, id]);
    state.set(id, "done");
  };
  for (const s of slices) walk(s.id, []);
}

/**
 * Validated on read, which is the path that actually matters: SLICES.jsonl is
 * written by the `plan` stage as a file, so `writeSlices` never runs in
 * production and its checks would be dead code. An unvalidated cyclic file
 * makes `nextRunnable` return null with slices still unbuilt — which the build
 * loop reads as "finished" rather than "malformed plan".
 */
export function readSlices(id: string, env?: Env): Slice[] {
  const slices = readRecords(artifactPath(id, SLICES_FILE, env), SliceSchema);
  validate(slices);
  return slices;
}

export function writeSlices(id: string, slices: Slice[], env?: Env): void {
  validate(slices);
  writeRecords(artifactPath(id, SLICES_FILE, env), SliceSchema, slices);
}

/** Transitive dependents of any failed slice — these must not be attempted. */
export function skippedBy(slices: Slice[], failed: string[]): string[] {
  const dead = new Set(failed);
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of slices) {
      if (dead.has(s.id)) continue;
      if (s.prerequisites.some((p) => dead.has(p))) {
        dead.add(s.id);
        grew = true;
      }
    }
  }
  for (const f of failed) dead.delete(f);
  return [...dead];
}

export function nextRunnable(
  slices: Slice[],
  progress: { passed: string[]; failed: string[] },
): Slice | null {
  const passed = new Set(progress.passed);
  const unavailable = new Set([...progress.failed, ...skippedBy(slices, progress.failed)]);

  for (const s of slices) {
    if (passed.has(s.id) || unavailable.has(s.id)) continue;
    if (s.prerequisites.every((p) => passed.has(p))) return s;
  }
  return null;
}

/** Slice criterion ids that match no criterion — a slice building nothing real. */
export function unknownCriterionIds(slices: Slice[], criterionIds: string[]): string[] {
  const known = new Set(criterionIds);
  return [...new Set(slices.flatMap((s) => s.criterionIds).filter((c) => !known.has(c)))].sort();
}

/**
 * Criteria no slice claims. These are the dangerous ones: a criterion missing
 * from every slice is never built, never tested, and never reported — it simply
 * drops out of the contract with nothing raising an objection.
 */
export function uncoveredCriterionIds(slices: Slice[], criterionIds: string[]): string[] {
  const covered = new Set(slices.flatMap((s) => s.criterionIds));
  return criterionIds.filter((c) => !covered.has(c));
}
