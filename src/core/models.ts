import { z } from "zod";

/**
 * Model families, cheapest first. A family is passed to Claude Code as its
 * alias (`--model opus`), which always means the newest release of it; the
 * exact model that ran is read back from each stage's log and kept with its
 * cost (MODELS_SPEC §2).
 */
export const FAMILIES = ["haiku", "sonnet", "opus"] as const;
export type Family = (typeof FAMILIES)[number];

/** The stages a person can set a model for, by the group each belongs to. */
export const GROUPS = {
  thinking: ["triage", "research", "spec", "plan", "review", "adjudicate"],
  building: ["test-write", "test-repair", "build", "smoke", "feedback"],
  writing: ["clarify", "deliver"],
} as const;
export type Group = keyof typeof GROUPS;
export const STAGES = Object.values(GROUPS).flat();
export type ModelStage = (typeof STAGES)[number];

export const ModelsSchema = z.strictObject({
  thinking: z.enum(FAMILIES),
  building: z.enum(FAMILIES),
  writing: z.enum(FAMILIES),
  /** Per-stage choices that win over the stage's group. */
  stages: z.partialRecord(z.enum(STAGES as [ModelStage, ...ModelStage[]]), z.enum(FAMILIES)).default({}),
  /** A retry runs one family up (sonnet → opus). */
  escalate: z.boolean(),
});
export type Models = z.infer<typeof ModelsSchema>;

export const DEFAULT_MODELS: Models = { thinking: "opus", building: "opus", writing: "sonnet", stages: {}, escalate: true };

/**
 * The stage a run belongs to, from the name its log goes by: `build-S-02` is
 * build, `adjudicate-S-01-answer` is adjudicate, `feedback-3` is feedback, and
 * a repair belongs to the stage it repairs.
 */
export function canonicalStage(logName: string): ModelStage | null {
  const base = logName.replace(/-repair$/, "");
  for (const stage of STAGES) {
    if (base === stage || base.startsWith(`${stage}-`)) return stage;
  }
  return null;
}

export function groupOf(stage: ModelStage): Group {
  return (Object.keys(GROUPS) as Group[]).find((g) => (GROUPS[g] as readonly string[]).includes(stage)) ?? "building";
}

/** The family a run gets: its stage's own choice, else its group's; one up on a retry when escalation is on. */
export function familyFor(logName: string, models: Models, retry: boolean): Family {
  const stage = canonicalStage(logName);
  const chosen = stage ? (models.stages[stage] ?? models[groupOf(stage)]) : models.building;
  if (!retry || !models.escalate) return chosen;
  return FAMILIES[Math.min(FAMILIES.indexOf(chosen) + 1, FAMILIES.length - 1)];
}

/** One change from `sfo prefs models …` or `sfo models <id> …`: a group's or stage's family, or escalation. */
export function changeModels(models: Models, args: string[]): Models {
  const [what, value] = args;
  const next: Models = structuredClone(models);
  if (what === "escalate") {
    if (value !== "on" && value !== "off") throw new Error("usage: models escalate on|off");
    next.escalate = value === "on";
    return next;
  }
  if (value === "group" && (STAGES as readonly string[]).includes(what ?? "")) {
    delete next.stages[what as ModelStage];
    return next;
  }
  const family = FAMILIES.find((f) => f === value);
  if (!family) throw new Error(`usage: models <${[...Object.keys(GROUPS), ...STAGES].join("|")}> <${FAMILIES.join("|")}|group>`);
  if (what === "thinking" || what === "building" || what === "writing") next[what] = family;
  else if ((STAGES as readonly string[]).includes(what ?? "")) next.stages[what as ModelStage] = family;
  else throw new Error(`no stage or group called "${what}"`);
  return next;
}

export function formatModels(m: Models): string {
  const stages = Object.entries(m.stages).map(([s, f]) => `${s} ${f}`);
  return [`thinking ${m.thinking}`, `building ${m.building}`, `writing ${m.writing}`, ...stages, `escalate ${m.escalate ? "on" : "off"}`].join(", ");
}

/**
 * The newest model of each family, for the one caller that needs an exact
 * id: triage's direct API call, which takes no alias. Update on a release;
 * everything else passes the family alias and follows releases by itself.
 */
export const NEWEST: Record<Family, string> = { haiku: "claude-haiku-5-5", sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5" };

/** "claude-opus-5-5" → "Opus 5.5", for people. Anything else as it is. */
export function modelName(id: string): string {
  const m = id.match(/^claude-(haiku|sonnet|opus)-(\d+)-(\d+)/);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : id;
}
