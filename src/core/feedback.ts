import fs from "node:fs";
import { z } from "zod";
import { artifactPath, projectDir, logPath, type Env } from "./paths.js";
import { readRecords, writeRecords } from "./jsonl.js";
import { readState } from "./state.js";
import { readSlices, type Slice } from "./slices.js";
import { readCriteria, writeCriteria, type Criterion } from "./criteria.js";
import { recordCost } from "./cost.js";
import { appendDecision } from "./decisions.js";
import { lockTests, readTestLock, verifyTestLock } from "./testlock.js";
import { TEST_DIR, agentToolsForStage, type VerifyResult } from "./verify.js";
import { SMOKE_DIR, verifyRecipeFor } from "./archetype.js";
import { changedPaths, commitStage, discardPaths } from "./repo.js";
import { takeContest, contestFor, contestInstructions } from "./contest.js";
import { adjudicate, type AdjudicationContext } from "./adjudicate.js";
import { loadPrompt } from "../stages/prompts.js";
import type { Runner, UsageLimit } from "../runner/types.js";

export const FEEDBACK_FILE = "FEEDBACK.jsonl";
export const FEEDBACK_RESULT_FILE = "FEEDBACK_RESULT.json";
export const MAX_FEEDBACK_ATTEMPTS = 2;

export const FeedbackEntrySchema = z.object({
  n: z.number().int().positive(),
  text: z.string().min(1),
  at: z.string(),
  status: z.enum(["pending", "done", "failed", "too_big"]),
  summary: z.string().optional(),
  reason: z.string().optional(),
});
export type FeedbackEntry = z.infer<typeof FeedbackEntrySchema>;

export function readFeedback(id: string, env?: Env): FeedbackEntry[] {
  return readRecords(artifactPath(id, FEEDBACK_FILE, env), FeedbackEntrySchema);
}

export function addFeedback(id: string, text: string, env?: Env): FeedbackEntry {
  const entries = readFeedback(id, env);
  const entry: FeedbackEntry = { n: entries.length + 1, text, at: new Date().toISOString(), status: "pending" };
  writeRecords(artifactPath(id, FEEDBACK_FILE, env), FeedbackEntrySchema, [...entries, entry]);
  return entry;
}

function updateFeedback(id: string, n: number, patch: Partial<FeedbackEntry>, env?: Env): void {
  const entries = readFeedback(id, env).map((e) => (e.n === n ? { ...e, ...patch } : e));
  writeRecords(artifactPath(id, FEEDBACK_FILE, env), FeedbackEntrySchema, entries);
}

const ResultSchema = z.object({
  verdict: z.enum(["done", "too_big"]),
  summary: z.string().min(1),
});

function takeResult(id: string, env: Env | undefined): z.infer<typeof ResultSchema> | null {
  const file = artifactPath(id, FEEDBACK_RESULT_FILE, env);
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, "utf8");
  fs.rmSync(file, { force: true });
  try {
    const parsed = ResultSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface FeedbackContext {
  id: string;
  env: Env | undefined;
  runner: Runner;
  archetype: string;
  verify: AdjudicationContext["verify"];
  suiteCheck: AdjudicationContext["suiteCheck"];
  passedGate: (id: string, archetype: string, passed: Slice[], env?: Env, extraTests?: string[]) => VerifyResult;
  withHeartbeat: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Reinstall and redraw once the change is in, so what the person runs and sees is current. */
  afterwards: () => void;
}

export type FeedbackOutcome =
  | { outcome: "done"; summary: string }
  | { outcome: "too_big"; summary: string }
  | { outcome: "failed"; reason: string }
  | { outcome: "limit"; limit: UsageLimit };

function tail(text: string, lines = 60): string {
  return text.trim().split("\n").slice(-lines).join("\n");
}

const isTestFile = (p: string): boolean =>
  (p.startsWith(`${TEST_DIR}/`) || p.startsWith(`${SMOKE_DIR}/`)) &&
  (/(^|\/)test_[^/]+\.py$/.test(p) || /\.test\.[cm]?[jt]s$/.test(p));

function prompt(text: string, gate: string[], previous: string | null, contest: ReturnType<typeof contestFor>, contestId: string): string {
  return [
    loadPrompt("feedback"),
    "",
    "## The feedback, in the person's words",
    "",
    text,
    "",
    "## The gate",
    "",
    "Your change is kept only if every one of these exits 0, in this order, with",
    "every test that passed before still passing and your new tests passing too:",
    "",
    ...gate.map((c) => `    ${c}`),
    "",
    ...contestInstructions(contestId, contest),
    ...(previous ? ["", "## Your previous attempt failed the gate", "", "Fix what this reports; your changes are still in the tree.", "", "```", previous, "```"] : []),
  ].join("\n");
}

/** Criteria the session added, removed or reworded, as the person's decisions. */
function recordCriteriaChanges(id: string, n: number, text: string, before: Criterion[], env: Env | undefined): void {
  let after: Criterion[];
  try {
    after = readCriteria(id, env);
  } catch {
    return;
  }
  const was = new Map(before.map((c) => [c.id, c.text]));
  const now = new Map(after.map((c) => [c.id, c.text]));
  const changed = [
    ...after.filter((c) => !was.has(c.id)).map((c) => `added ${c.id}: ${c.text}`),
    ...after.filter((c) => was.has(c.id) && was.get(c.id) !== c.text).map((c) => `reworded ${c.id}: ${c.text}`),
    ...before.filter((c) => !now.has(c.id)).map((c) => `dropped ${c.id}`),
  ];
  if (changed.length === 0) return;
  appendDecision(
    id,
    {
      id: `D-feedback-${n}`,
      decision: `What the criteria say after feedback ${n}`,
      chose: changed.join("; "),
      considered: "the criteria as they were",
      why: `The person's feedback: ${text}`,
      decided_by: "human",
      blast_radius: "local",
      at: new Date().toISOString(),
    },
    env,
  );
}

function appendToSummary(id: string, entry: FeedbackEntry, summary: string, env: Env | undefined): void {
  const file = artifactPath(id, "SUMMARY.md", env);
  if (!fs.existsSync(file)) return;
  const body = fs.readFileSync(file, "utf8");
  const heading = "## Changes after delivery";
  const section = [
    ...(body.includes(heading) ? [] : ["", heading]),
    "",
    `### Feedback ${entry.n} — ${entry.at.slice(0, 10)}`,
    "",
    ...entry.text.split("\n").map((l) => `> ${l}`),
    "",
    summary,
    "",
  ].join("\n");
  fs.writeFileSync(file, `${body.trimEnd()}\n${section}`);
}

/**
 * A follow-up the size of a prompt or two: one agent session with the
 * person's words, gated on nothing that passed breaking. Not the pipeline:
 * the same agent writes the new tests and the code, which is accepted here
 * because the locked suite guards what already worked and the person looks
 * at the result.
 */
export async function runFeedback(ctx: FeedbackContext, n: number): Promise<FeedbackOutcome> {
  const { id, env, archetype } = ctx;
  const entry = readFeedback(id, env).find((e) => e.n === n);
  if (!entry) return { outcome: "failed", reason: `no feedback entry ${n}` };
  const dir = projectDir(id, env);
  const stage = `feedback-${n}`;
  const contestId = `FEEDBACK-${n}`;
  const criteriaBefore = readCriteria(id, env);
  const passed = (): Slice[] => {
    const ids = new Set(readState(id, env).slicesPassed);
    return readSlices(id, env).filter((s) => ids.has(s.id));
  };
  const gateCommands = verifyRecipeFor(archetype).map((s) => [s.command, ...s.args].join(" "));
  const giveUp = (reason: string): FeedbackOutcome => {
    discardPaths(dir, changedPaths(dir));
    writeCriteria(id, criteriaBefore, env);
    updateFeedback(id, n, { status: "failed", reason }, env);
    return { outcome: "failed", reason };
  };

  let attempts = 0;
  let previous: string | null = null;
  while (attempts < MAX_FEEDBACK_ATTEMPTS) {
    const result = await ctx.withHeartbeat(() =>
      ctx.runner.runStage({
        workdir: dir,
        prompt: prompt(entry.text, gateCommands, previous, contestFor(id, contestId, env), contestId),
        logPath: logPath(id, stage, env),
        allowedTools: agentToolsForStage(id, "feedback-repair", env),
      }),
    );
    recordCost(id, stage, result.ok, result.usage, env, "cli", result.billing);
    if (result.limited) return { outcome: "limit", limit: result.limited };

    const outcome = takeResult(id, env);
    if (outcome?.verdict === "too_big") {
      discardPaths(dir, changedPaths(dir));
      writeCriteria(id, criteriaBefore, env);
      updateFeedback(id, n, { status: "too_big", summary: outcome.summary }, env);
      return { outcome: "too_big", summary: outcome.summary };
    }

    const taken = takeContest(id, contestId, env);
    if (taken.kind === "contest" && !contestFor(id, contestId, env)) {
      await adjudicate(
        { id, env, runner: ctx.runner, archetype, slices: readSlices(id, env), verify: ctx.verify, suiteCheck: ctx.suiteCheck, withHeartbeat: ctx.withHeartbeat },
        { id: contestId, name: `feedback ${n}`, criterionIds: ["(feedback)"], prerequisites: [] },
        taken.contest,
        false,
      );
      continue;
    }

    attempts++;
    // Existing tests are the contract for everything that worked; new files
    // are the feedback's own tests, and are allowed.
    const locked = readTestLock(id, env);
    const drift = verifyTestLock(id, TEST_DIR, env);
    const edited = drift.filter((p) => p in locked);
    const added = drift.filter((p) => !(p in locked) && isTestFile(p));
    if (edited.length > 0) {
      previous = `You changed tests that were already locked: ${edited.join(", ")}. Put them back; if one contradicts the feedback, contest it instead.`;
      discardPaths(dir, edited);
      continue;
    }
    const verdict = ctx.passedGate(id, archetype, passed(), env, added);
    if (!verdict.ok) {
      const step = verdict.steps.find((s) => !s.ok);
      previous = [verdict.reason ?? "", step?.output ? tail(step.output) : ""].filter(Boolean).join("\n");
      continue;
    }

    lockTests(id, TEST_DIR, env);
    recordCriteriaChanges(id, n, entry.text, criteriaBefore, env);
    const summary = outcome?.summary ?? "Changed as asked; the agent left no summary.";
    appendToSummary(id, entry, summary, env);
    updateFeedback(id, n, { status: "done", summary }, env);
    commitStage(id, stage, env);
    try {
      ctx.afterwards();
    } catch (err) {
      console.error(`sfo: the change is in, but reinstalling or redrawing failed — ${err instanceof Error ? err.message : String(err)}`);
    }
    return { outcome: "done", summary };
  }
  return giveUp(`failed the gate ${MAX_FEEDBACK_ATTEMPTS} times; last: ${previous?.split("\n")[0] ?? "no output"}`);
}
