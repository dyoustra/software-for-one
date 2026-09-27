import path from "node:path";
import { readState, writeState } from "./state.js";
import { readCriteria, writeCriteria, CRITERIA_FILE, type Criterion } from "./criteria.js";
import { recordCost } from "./cost.js";
import { appendDecision } from "./decisions.js";
import { readQuestions, writeQuestions, readAnswers } from "./questions.js";
import { openQuestions } from "./openQuestions.js";
import { lockTests, verifyTestLock, TEST_LOCK_FILE } from "./testlock.js";
import { appendVerifyRecord } from "./verifyRecord.js";
import { TEST_DIR, agentToolsForStage, type VerifyResult } from "./verify.js";
import { changedPaths, commitPaths, discardPaths, restoreWork, stashWork } from "./repo.js";
import {
  readContests,
  writeContests,
  takeRuling,
  type Contest,
  type ContestRecord,
  type Ruling,
} from "./contest.js";
import { loadPrompt } from "../stages/prompts.js";
import { projectDir, logPath, type Env } from "./paths.js";
import type { Slice } from "./slices.js";
import type { Runner, StageResult, UsageLimit } from "../runner/types.js";

export interface AdjudicationContext {
  id: string;
  env: Env | undefined;
  runner: Runner;
  archetype: string;
  slices: Slice[];
  verify: (id: string, archetype: string, slice: Slice, env?: Env) => VerifyResult;
  suiteCheck: (id: string, env?: Env) => VerifyResult;
  /** Keeps the project's heartbeat alive while the adjudicator runs. */
  withHeartbeat: <T>(fn: () => Promise<T>) => Promise<T>;
}

export type AdjudicationOutcome =
  | { kind: "ruled" }
  | { kind: "limit"; stage: string; limit: UsageLimit }
  | { kind: "criterion"; sliceId: string; criterionId: string; questionId: string };

/** The files the test lock covers are the only ones the adjudicator may touch. */
export function isTestPath(p: string): boolean {
  return p.startsWith(`${TEST_DIR}/`) || path.basename(p) === "conftest.py";
}

/**
 * Runs `fn` with the slice's unfinished work set aside, so the adjudicator
 * judges the test against HEAD, not against code that may have bent to fit it,
 * and so an amendment is committed without that work riding along.
 */
async function withWorkSetAside<T>(ctx: AdjudicationContext, fn: () => Promise<T>): Promise<T> {
  const dir = projectDir(ctx.id, ctx.env);
  const stashed = stashWork(dir);
  try {
    return await fn();
  } finally {
    if (!restoreWork(dir, stashed)) {
      console.error(
        "sfo: the slice's unfinished work no longer applied after the test was amended, " +
          "and was discarded — its next attempt starts from the committed tree",
      );
    }
  }
}

async function runAdjudicator(
  ctx: AdjudicationContext,
  stage: string,
  prompt: string,
): Promise<StageResult> {
  const { id, env } = ctx;
  const result = await ctx.withHeartbeat(() =>
    ctx.runner.runStage({
      workdir: projectDir(id, env),
      prompt,
      logPath: logPath(id, stage, env),
      allowedTools: agentToolsForStage(id, stage, env),
    }),
  );
  recordCost(id, stage, result.ok, result.usage, env, "cli", result.billing);
  return result;
}

function contestPrompt(contest: Contest, criterion: Criterion | undefined): string {
  return [
    loadPrompt("adjudicate"),
    "",
    "## The contest",
    "",
    `Criterion ${contest.criterionId}: ${criterion?.text ?? "(not found in .sfo/CRITERIA.jsonl)"}`,
    "",
    "```json",
    JSON.stringify(contest, null, 2),
    "```",
  ].join("\n");
}

function patchPrompt(record: ContestRecord, criterion: Criterion | undefined, answer: string): string {
  return [
    loadPrompt("adjudicate"),
    "",
    "## Patch mode",
    "",
    `You ruled criterion ${record.criterionId} defective and the person has answered.`,
    `The criterion: ${criterion?.text ?? "(not found)"}`,
    `Why you ruled it defective: ${record.rulingWhy}`,
    `Their answer, in their words: ${answer}`,
    "",
    `Rewrite the \`text\` of ${record.criterionId} in \`.sfo/${CRITERIA_FILE}\` to say what they`,
    "meant. Keep its `id` and `group`, and leave every other line byte-identical.",
    `Then make ${record.testFile} check the rewritten criterion, under the`,
    "`amend_test` rules above, and write `.sfo/RULING.json` with",
    '`"ruling":"amend_test"`. Here, and only here, you may write the criteria file.',
  ].join("\n");
}

type Judged = { ruling: Ruling; changed: string[] };

function upheld(why: string): Ruling {
  return { ruling: "uphold", why, changedFiles: [], question: null };
}

/**
 * The ruling as it stands after the mechanical checks. A ruling that cannot be
 * trusted becomes `uphold`: the test was locked for a reason, and the default
 * when the judge misbehaves is that it stays.
 */
function judge(ctx: AdjudicationContext, result: StageResult, criterionChanged = false): Judged {
  const dir = projectDir(ctx.id, ctx.env);
  const taken = takeRuling(ctx.id, ctx.env);
  const changed = changedPaths(dir);
  const discard = (why: string): Judged => {
    discardPaths(dir, changed);
    return { ruling: upheld(why), changed: [] };
  };

  if (typeof taken === "string") {
    return discard(`no ruling was made (${taken}${result.ok ? "" : `; the adjudicator exited ${result.exitCode}`})`);
  }
  const outside = changed.filter((p) => !isTestPath(p));
  if (outside.length > 0) {
    return discard(`the adjudicator changed ${outside.join(", ")}, outside the test tree, so its ruling was discarded`);
  }
  if (taken.ruling !== "amend_test") {
    discardPaths(dir, changed);
    return { ruling: taken, changed: [] };
  }
  if (verifyTestLock(ctx.id, TEST_DIR, ctx.env).length === 0) {
    // In patch mode a reworded criterion the test already checks is a
    // complete amendment on its own.
    if (criterionChanged) return { ruling: taken, changed: [] };
    return discard("the ruling was to amend the test, but nothing the lock covers changed");
  }
  const checked = ctx.suiteCheck(ctx.id, ctx.env);
  if (!checked.ok) {
    const step = checked.steps.find((s) => !s.ok);
    const detail = step?.output.trim().split("\n").slice(-10).join("\n") ?? checked.reason ?? "";
    return discard(`the amended suite does not pass ${step?.name ?? "the pre-lock check"}:\n${detail}`);
  }
  return { ruling: taken, changed };
}

/**
 * Locks and commits an amended suite, then re-grades every slice that had
 * passed: the amendment may be to shared support, and "passed" has to keep
 * meaning passed against the suite as it now stands.
 */
function relock(ctx: AdjudicationContext, sliceId: string, message: string, paths: string[]): string[] {
  const { id, env } = ctx;
  lockTests(id, TEST_DIR, env);
  commitPaths(projectDir(id, env), message, [...paths, `.sfo/${TEST_LOCK_FILE}`]);

  const state = readState(id, env);
  const reopened: string[] = [];
  for (const sid of state.slicesPassed) {
    const slice = ctx.slices.find((s) => s.id === sid);
    if (!slice) continue;
    const verdict = ctx.verify(id, ctx.archetype, slice, env);
    try {
      appendVerifyRecord(
        id,
        {
          slice: sid,
          attempt: (state.sliceAttempts[sid] ?? 0) + 1,
          ok: verdict.ok,
          archetype: ctx.archetype,
          failedStep: verdict.steps.find((s) => !s.ok)?.name,
          reason: verdict.ok ? undefined : (verdict.reason ?? "failed after the suite was amended"),
          tamperedTests: verdict.tamperedTests,
          trigger: "relock",
          at: new Date().toISOString(),
        },
        env,
      );
    } catch {
      // The record is diagnostics; the reopening below is what matters.
    }
    if (!verdict.ok) reopened.push(sid);
  }

  // The contested slice was graded against a broken test, so its failures so
  // far say nothing about it. Reopened slices start over for the same reason.
  resetAttempts(ctx, [sliceId, ...reopened], reopened);
  if (reopened.length > 0) {
    console.error(`sfo: ${reopened.join(", ")} no longer pass the amended suite and will be built again`);
  }
  return reopened;
}

function resetAttempts(ctx: AdjudicationContext, sliceIds: string[], reopened: string[] = []): void {
  const state = readState(ctx.id, ctx.env);
  const sliceAttempts = { ...state.sliceAttempts };
  for (const s of sliceIds) delete sliceAttempts[s];
  writeState(
    {
      ...state,
      slicesPassed: state.slicesPassed.filter((s) => !reopened.includes(s)),
      sliceAttempts,
      updatedAt: new Date().toISOString(),
    },
    ctx.env,
  );
}

function recordDecision(
  ctx: AdjudicationContext,
  record: ContestRecord,
  decidedBy: "adjudicator" | "human",
): void {
  try {
    appendDecision(
      ctx.id,
      {
        id: `D-contest-${record.sliceId}${decidedBy === "human" ? "-answer" : ""}`,
        decision: `Whether ${record.testFile} ${record.testName} correctly tests ${record.criterionId}`,
        chose: record.ruling,
        considered: "uphold the test; amend the test; ask the person about the criterion",
        why: record.rulingWhy,
        decided_by: decidedBy,
        blast_radius: record.ruling === "uphold" ? "local" : "structural",
        at: record.ruledAt,
      },
      ctx.env,
    );
  } catch (err) {
    console.error(`sfo: could not record the ruling on ${record.sliceId} — ${err instanceof Error ? err.message : String(err)}`);
  }
}

function saveRecord(ctx: AdjudicationContext, record: ContestRecord): void {
  const others = readContests(ctx.id, ctx.env).filter((r) => r.sliceId !== record.sliceId);
  writeContests(ctx.id, [...others, record], ctx.env);
}

/** Rules on a slice's contest and acts on the ruling. */
export async function adjudicate(
  ctx: AdjudicationContext,
  slice: Slice,
  contest: Contest,
  /**
   * False outside the build: only the slice loop resumes a criterion park, so
   * elsewhere a questioned criterion is recorded and reported, not parked.
   */
  mayPark = true,
): Promise<AdjudicationOutcome> {
  const openedAt = new Date().toISOString();
  const stage = `adjudicate-${slice.id}`;
  const criterion = readCriteria(ctx.id, ctx.env).find((c) => c.id === contest.criterionId);

  return withWorkSetAside(ctx, async () => {
    const result = await runAdjudicator(ctx, stage, contestPrompt(contest, criterion));
    if (result.limited) {
      // Not ruled, so not spent: nothing is recorded, and the slice may contest again.
      discardPaths(projectDir(ctx.id, ctx.env), changedPaths(projectDir(ctx.id, ctx.env)));
      takeRuling(ctx.id, ctx.env);
      return { kind: "limit", stage, limit: result.limited };
    }

    const { ruling, changed } = judge(ctx, result);
    const record: ContestRecord = {
      ...contest,
      status: ruling.ruling === "criterion_defect" ? "awaiting_answer" : "ruled",
      ruling: ruling.ruling,
      rulingWhy: ruling.why,
      changedFiles: changed,
      decided_by: "adjudicator",
      openedAt,
      ruledAt: new Date().toISOString(),
    };

    if (ruling.ruling === "criterion_defect" && !mayPark) {
      const reported: ContestRecord = { ...record, status: "ruled" };
      saveRecord(ctx, reported);
      recordDecision(ctx, reported, "adjudicator");
      return { kind: "ruled" };
    }

    if (ruling.ruling === "criterion_defect" && ruling.question) {
      const questionId = `CQ-${slice.id}`;
      const existing = readQuestions(ctx.id, ctx.env)?.questions ?? [];
      writeQuestions(
        ctx.id,
        {
          questions: [
            ...existing.filter((q) => q.id !== questionId),
            { id: questionId, section: "blocking", ...ruling.question },
          ],
        },
        ctx.env,
      );
      saveRecord(ctx, { ...record, questionId });
      recordDecision(ctx, record, "adjudicator");
      return { kind: "criterion", sliceId: slice.id, criterionId: contest.criterionId, questionId };
    }

    saveRecord(ctx, record);
    if (ruling.ruling === "amend_test") {
      relock(ctx, slice.id, `adjudicate(${slice.id}): ${firstLine(ruling.why)}`, changed);
    }
    recordDecision(ctx, record, "adjudicator");
    return { kind: "ruled" };
  });
}

/**
 * Picks up a criterion parked for the human. Null when none is pending;
 * the same park again while its question is still unanswered.
 */
export async function resumeCriterion(ctx: AdjudicationContext): Promise<AdjudicationOutcome | null> {
  const { id, env } = ctx;
  const pending = readContests(id, env).find((r) => r.status === "awaiting_answer");
  if (!pending?.questionId) return null;

  const park: AdjudicationOutcome = {
    kind: "criterion",
    sliceId: pending.sliceId,
    criterionId: pending.criterionId,
    questionId: pending.questionId,
  };
  if (openQuestions(id, env).some((q) => q.id === pending.questionId)) return park;
  const answer = readAnswers(id, env)?.answers.find((a) => a.questionId === pending.questionId)?.answer;
  if (answer === undefined) return park;

  const stage = `adjudicate-${pending.sliceId}-answer`;
  const before = readCriteria(id, env);
  const criterion = before.find((c) => c.id === pending.criterionId);

  return withWorkSetAside(ctx, async () => {
    const result = await runAdjudicator(ctx, stage, patchPrompt(pending, criterion, answer));
    if (result.limited) {
      discardPaths(projectDir(id, env), changedPaths(projectDir(id, env)));
      writeCriteria(id, before, env);
      takeRuling(id, env);
      return { kind: "limit", stage, limit: result.limited };
    }

    const criteriaProblem = patchedCriteriaProblem(id, env, before, pending.criterionId);
    let judged: Judged;
    if (criteriaProblem) {
      discardPaths(projectDir(id, env), changedPaths(projectDir(id, env)));
      takeRuling(id, env);
      judged = { ruling: upheld(criteriaProblem), changed: [] };
    } else {
      const reworded =
        JSON.stringify(readCriteria(id, env).find((c) => c.id === pending.criterionId)) !==
        JSON.stringify(criterion);
      judged = judge(ctx, result, reworded);
    }
    const applied = !criteriaProblem && judged.ruling.ruling === "amend_test";
    if (!applied) writeCriteria(id, before, env);

    const record: ContestRecord = {
      ...pending,
      status: "ruled",
      ruling: applied ? "amend_test" : "uphold",
      rulingWhy: `${answer} — ${judged.ruling.why}`,
      changedFiles: judged.changed,
      decided_by: "human",
      ruledAt: new Date().toISOString(),
    };
    saveRecord(ctx, record);
    const message = `adjudicate(${pending.sliceId}): ${pending.criterionId} rewritten from the answer`;
    if (applied && judged.changed.length > 0) {
      relock(ctx, pending.sliceId, message, [...judged.changed, `.sfo/${CRITERIA_FILE}`]);
    } else if (applied) {
      commitPaths(projectDir(id, env), message, [`.sfo/${CRITERIA_FILE}`]);
      resetAttempts(ctx, [pending.sliceId]);
    } else {
      console.error(`sfo: the answer on ${pending.criterionId} was not applied — ${judged.ruling.why}`);
    }
    recordDecision(ctx, record, "human");
    return { kind: "ruled" };
  });
}

/** Patch mode may reword exactly one criterion and nothing else in the file. */
function patchedCriteriaProblem(
  id: string,
  env: Env | undefined,
  before: Criterion[],
  criterionId: string,
): string | null {
  let after: Criterion[];
  try {
    after = readCriteria(id, env);
  } catch (err) {
    return `the criteria file no longer reads: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (after.length !== before.length || after.some((c, i) => c.id !== before[i].id)) {
    return "the criteria file gained, lost or reordered criteria";
  }
  const others = after.filter(
    (c, i) => c.id !== criterionId && JSON.stringify(c) !== JSON.stringify(before[i]),
  );
  if (others.length > 0) return `criteria other than ${criterionId} changed: ${others.map((c) => c.id).join(", ")}`;
  const mine = after.find((c) => c.id === criterionId);
  const was = before.find((c) => c.id === criterionId);
  if (mine && was && mine.group !== was.group) return `${criterionId}'s group changed`;
  return null;
}

function firstLine(text: string): string {
  const line = text.split("\n")[0] ?? "";
  return line.length > 72 ? `${line.slice(0, 71)}…` : line;
}
