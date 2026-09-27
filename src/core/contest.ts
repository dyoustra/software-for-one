import fs from "node:fs";
import { z } from "zod";
import { artifactPath, type Env } from "./paths.js";
import { readRecords, writeRecords } from "./jsonl.js";
import { QuestionSchema } from "./questions.js";

export const CONTEST_FILE = "CONTEST.json";
export const RULING_FILE = "RULING.json";
export const CONTESTS_FILE = "CONTESTS.jsonl";

/** What a build agent writes instead of working around a test it believes is wrong. */
export const ContestSchema = z.object({
  sliceId: z.string().min(1),
  criterionId: z.string().min(1),
  testFile: z.string().min(1),
  testName: z.string(),
  claim: z.enum(["unsatisfiable", "contradicts_criterion", "forces_wrong_code"]),
  why: z.string().min(1),
  proposedFix: z.string(),
});
export type Contest = z.infer<typeof ContestSchema>;

export const RULINGS = ["uphold", "amend_test", "criterion_defect"] as const;
export type RulingKind = (typeof RULINGS)[number];

export const RulingSchema = z
  .object({
    ruling: z.enum(RULINGS),
    why: z.string().min(1),
    changedFiles: z.array(z.string()).default([]),
    question: QuestionSchema.omit({ id: true, section: true }).nullable().default(null),
  })
  .refine((r) => (r.ruling === "criterion_defect") === (r.question !== null), {
    message: "a question is required with criterion_defect, and only then",
  });
export type Ruling = z.infer<typeof RulingSchema>;

/**
 * One contest and what became of it. `awaiting_answer` is a criterion the
 * adjudicator found at fault, parked until the human says what it should be.
 */
export const ContestRecordSchema = ContestSchema.extend({
  status: z.enum(["ruled", "awaiting_answer"]),
  ruling: z.enum(RULINGS),
  rulingWhy: z.string().min(1),
  changedFiles: z.array(z.string()),
  questionId: z.string().optional(),
  decided_by: z.enum(["adjudicator", "human"]),
  openedAt: z.string(),
  ruledAt: z.string(),
});
export type ContestRecord = z.infer<typeof ContestRecordSchema>;

export function readContests(id: string, env?: Env): ContestRecord[] {
  return readRecords(artifactPath(id, CONTESTS_FILE, env), ContestRecordSchema);
}

export function writeContests(id: string, records: ContestRecord[], env?: Env): void {
  writeRecords(artifactPath(id, CONTESTS_FILE, env), ContestRecordSchema, records);
}

/** A slice gets one contest; this is it, if spent. */
export function contestFor(id: string, sliceId: string, env?: Env): ContestRecord | undefined {
  return readContests(id, env).find((r) => r.sliceId === sliceId);
}

export type Taken =
  | { kind: "none" }
  | { kind: "invalid"; reason: string }
  | { kind: "contest"; contest: Contest };

/**
 * Reads and removes the agent's contest. Removed whatever it held, so a
 * contest is acted on once and never found again by the next attempt.
 */
export function takeContest(id: string, sliceId: string, env?: Env): Taken {
  const file = artifactPath(id, CONTEST_FILE, env);
  if (!fs.existsSync(file)) return { kind: "none" };
  const text = fs.readFileSync(file, "utf8");
  fs.rmSync(file, { force: true });

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: "invalid", reason: `${CONTEST_FILE} is not valid JSON` };
  }
  const parsed = ContestSchema.safeParse(raw);
  if (!parsed.success) {
    return { kind: "invalid", reason: `${CONTEST_FILE} does not match its schema: ${parsed.error.message}` };
  }
  if (parsed.data.sliceId !== sliceId) {
    return { kind: "invalid", reason: `${CONTEST_FILE} names ${parsed.data.sliceId}, but this slice is ${sliceId}` };
  }
  return { kind: "contest", contest: parsed.data };
}

/** The adjudicator's ruling, removed once read for the same reason. */
export function takeRuling(id: string, env?: Env): Ruling | string {
  const file = artifactPath(id, RULING_FILE, env);
  if (!fs.existsSync(file)) return `the adjudicator wrote no ${RULING_FILE}`;
  const text = fs.readFileSync(file, "utf8");
  fs.rmSync(file, { force: true });
  try {
    const parsed = RulingSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : `${RULING_FILE} is invalid: ${parsed.error.message}`;
  } catch {
    return `${RULING_FILE} is not valid JSON`;
  }
}

/**
 * The way out of a wrong test, offered once. Without it an agent facing a
 * test no correct code can pass has two moves: fail, or bend the code until
 * the test is satisfied — which in the first real build is what it did.
 */
export function contestInstructions(sliceId: string, contest: ContestRecord | undefined): string[] {
  if (!contest) {
    return [
      "## If a test is wrong",
      "",
      "If you are confident a test for your work is wrong — it contradicts its",
      "criterion, no correct implementation could satisfy it, or only code that",
      "would be wrong in real use can pass it — do not work around it, and do not",
      "change production code to fit it. Write `.sfo/CONTEST.json` and stop:",
      "",
      `    {"sliceId":"${sliceId}","criterionId":"AC-...","testFile":"tests/...","testName":"test_...",`,
      '     "claim":"unsatisfiable | contradicts_criterion | forces_wrong_code",',
      '     "why":"<what is wrong, with the evidence>","proposedFix":"<how the test should change>"}',
      "",
      "An independent adjudicator rules on it. You get one contest for this work.",
      "A contest ruled against you costs nothing but time; working around a wrong",
      "test is a defect in what you deliver.",
    ];
  }
  const test = `${contest.testFile} ${contest.testName}`.trim();
  if (contest.ruling === "uphold") {
    return [
      "## Your contest was ruled against",
      "",
      `You contested ${test}. The adjudicator upheld it:`,
      "",
      contest.rulingWhy,
      "",
      "The test stands. Make it pass without changing any test.",
    ];
  }
  return [
    "## Your contest was upheld",
    "",
    `You contested ${test}, and the test was amended (${contest.changedFiles.join(", ") || "criterion reworded"}):`,
    "",
    contest.rulingWhy,
    "",
    "The suite is locked again as amended. Your contest is spent.",
  ];
}
