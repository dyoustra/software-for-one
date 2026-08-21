export const PHASE_1_STAGES = ["capture", "research", "spec", "clarify"] as const;

export type Stage = (typeof PHASE_1_STAGES)[number];

const HUMAN_STAGES = new Set<string>(["clarify"]);

export function nextStage(stage: string): Stage | null {
  const i = PHASE_1_STAGES.indexOf(stage as Stage);
  if (i === -1) throw new Error(`unknown stage: ${stage}`);
  return PHASE_1_STAGES[i + 1] ?? null;
}

export function blocksOnHuman(stage: string): boolean {
  return HUMAN_STAGES.has(stage);
}
