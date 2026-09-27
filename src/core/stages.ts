export const PIPELINE_STAGES = [
  "capture",
  "research",
  "spec",
  "clarify",
  "plan",
  "test-write",
  "test-repair",
  "build",
  "smoke",
  "review",
  "deliver",
] as const;

export type Stage = (typeof PIPELINE_STAGES)[number];

/**
 * `build` runs the slice loop internally and verifies each slice as it lands,
 * so verification is not a stage of its own — a slice that builds but fails its
 * gate must not be able to reach a later stage that says otherwise.
 */

/**
 * One gate, deliberately. `plan` was considered and rejected: a plan review a
 * human rubber-stamps is a round-trip that buys nothing, and the premise of the
 * product is that you dictate an idea and walk away. Everything that needs a
 * human is asked at `clarify`, which can append a follow-up question and park
 * again rather than guessing.
 */
const HUMAN_STAGES = new Set<string>(["clarify"]);

export function nextStage(stage: string): Stage | null {
  const i = PIPELINE_STAGES.indexOf(stage as Stage);
  if (i === -1) throw new Error(`unknown stage: ${stage}`);
  return PIPELINE_STAGES[i + 1] ?? null;
}

export function blocksOnHuman(stage: string): boolean {
  return HUMAN_STAGES.has(stage);
}

/**
 * How to recover from a stage that failed. `build` is the exception: it runs
 * one slice at a time, and `sfo stage` has no slice to name — pointing there
 * would send the build prompt an instruction it says it requires and has not
 * been given.
 */
export function recoveryHint(id: string, stage: string): string {
  if (stage === "build") {
    return `clear the failed slices with \`sfo retry ${id}\`, then \`sfo run ${id}\``;
  }
  return `re-run it with \`sfo stage ${id} ${stage}\` before advancing`;
}
