import fs from "node:fs";
import path from "node:path";
import {
  readFindings,
  writeFindings,
  isRepairable,
  REVIEW_TEST_DIR,
  MAX_TEST_ADJUDICATIONS,
  type Finding,
} from "./findings.js";
import { readDecisions } from "./decisions.js";
import { readState } from "./state.js";
import { readSlices, type Slice } from "./slices.js";
import { recordCost } from "./cost.js";
import { lockTests, verifyTestLock, TEST_LOCK_FILE } from "./testlock.js";
import { TEST_DIR, agentToolsForStage, type VerifyResult } from "./verify.js";
import { verifyRecipeFor } from "./archetype.js";
import { changedPaths, commitPaths, commitStage, discardPaths, headCommit, revertCommit } from "./repo.js";
import { takeContest, contestFor, contestInstructions } from "./contest.js";
import { adjudicate, type AdjudicationContext } from "./adjudicate.js";
import { loadPrompt } from "../stages/prompts.js";
import { projectDir, logPath, type Env } from "./paths.js";
import type { Runner, StageResult, UsageLimit } from "../runner/types.js";

export const MAX_REVIEW_REPAIRS = 2;
export const REVIEW_CONTEST_ID = "REVIEW";

export interface ReviewContext {
  id: string;
  env: Env | undefined;
  runner: Runner;
  archetype: string;
  verify: AdjudicationContext["verify"];
  suiteCheck: AdjudicationContext["suiteCheck"];
  passedGate: (id: string, archetype: string, passed: Slice[], env?: Env, extraTests?: string[]) => VerifyResult;
  /** Runs only these test files; `ok` means they pass against the code as it stands. */
  runTests: (id: string, archetype: string, files: string[], env?: Env) => VerifyResult;
  budgetExceeded: () => boolean;
  withHeartbeat: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Smoke again, without repair, after a repair changed the code. */
  resmoke: () => Promise<void>;
}

export type ReviewOutcome =
  | { outcome: "complete" }
  | { outcome: "failed"; reason: string }
  | { outcome: "limit"; stage: string; limit: UsageLimit }
  | { outcome: "budget"; stage: string };

function tail(text: string, lines = 60): string {
  return text.trim().split("\n").slice(-lines).join("\n");
}

async function runAgent(ctx: ReviewContext, stage: string, prompt: string): Promise<StageResult> {
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

/** A malformed findings file loses the findings, not the build. */
function findingsOrNone(id: string, env: Env | undefined): Finding[] {
  try {
    return readFindings(id, env);
  } catch (err) {
    console.error(`sfo: review's findings could not be read, so none will be repaired — ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function humanDecisionIds(id: string, env: Env | undefined): Set<string> {
  try {
    return new Set(readDecisions(id, env).filter((d) => d.decided_by === "human").map((d) => d.id));
  } catch {
    return new Set();
  }
}

const inReviewTests = (p: string): boolean => p.startsWith(`${REVIEW_TEST_DIR}/`);

/**
 * Settles round 1's findings into the ones worth a repair, each backed by a
 * test that fails right now, and the ones only worth reporting.
 */
function triageFindings(ctx: ReviewContext, raw: Finding[]): Finding[] {
  const { id, env, archetype } = ctx;
  const dir = projectDir(id, env);

  // The reviewer reads; the only things it may leave behind are its tests.
  discardPaths(dir, changedPaths(dir).filter((p) => !inReviewTests(p)));

  const human = humanDecisionIds(id, env);
  let findings: Finding[] = raw.map((f) => {
    const base = { ...f, round: 1 as const };
    if (f.decisionId && human.has(f.decisionId)) {
      return { ...base, status: "dropped", statusWhy: `contradicts ${f.decisionId}, which the person decided` };
    }
    if (!isRepairable(base)) return { ...base, status: "report_only" };
    if (!f.test || !inReviewTests(f.test) || !fs.existsSync(path.join(dir, f.test))) {
      return { ...base, status: "unrepaired", statusWhy: `no reproduction test was written under ${REVIEW_TEST_DIR}/` };
    }
    return { ...base, status: "open" };
  });

  const discardUnkept = (): void => {
    const keep = new Set(findings.filter((f) => f.status === "open").map((f) => f.test));
    discardPaths(dir, changedPaths(dir).filter((p) => inReviewTests(p) && !keep.has(p)));
  };
  const failAll = (why: string): void => {
    findings = findings.map((f) => (f.status === "open" ? { ...f, status: "unrepaired", statusWhy: why } : f));
  };
  discardUnkept();
  if (!findings.some((f) => f.status === "open")) return findings;

  // Relocking launders whatever changed since the last lock, so anything but
  // the reviewer's own additions means the new tests are not locked at all.
  const drift = verifyTestLock(id, TEST_DIR, env).filter((p) => !inReviewTests(p));
  if (drift.length > 0) {
    failAll(`the suite changed outside ${REVIEW_TEST_DIR}/ since it was locked: ${drift.join(", ")}`);
    discardUnkept();
    return findings;
  }

  const checked = ctx.suiteCheck(id, env);
  if (!checked.ok) {
    const step = checked.steps.find((s) => !s.ok);
    failAll(`the review tests do not pass ${step?.name ?? "the pre-lock check"}: ${tail(step?.output ?? checked.reason ?? "", 10)}`);
    discardUnkept();
    return findings;
  }

  // A reproduction that passes reproduces nothing: the reviewer was wrong
  // about the code, and the code said so.
  findings = findings.map((f) => {
    if (f.status !== "open" || !f.test) return f;
    return ctx.runTests(id, archetype, [f.test], env).ok
      ? { ...f, status: "not_reproduced", statusWhy: "its test passed against the code as built" }
      : f;
  });
  discardUnkept();

  const tests = findings.filter((f) => f.status === "open").map((f) => f.test as string);
  if (tests.length > 0) {
    lockTests(id, TEST_DIR, env);
    commitPaths(dir, `review: reproduction tests for ${findings.filter((f) => f.status === "open").map((f) => f.id).join(", ")}`, [
      ...tests,
      `.sfo/${TEST_LOCK_FILE}`,
    ]);
  }
  return findings;
}

function repairPrompt(
  open: Finding[],
  gate: string[],
  previous: string | null,
  contest: ReturnType<typeof contestFor>,
): string {
  return [
    loadPrompt("review-repair"),
    "",
    "## Findings to repair",
    "",
    ...open.flatMap((f) => [
      `### ${f.id}${f.criterionId ? ` (${f.criterionId})` : ""}: ${f.summary}`,
      "",
      f.evidence,
      "",
      `Reproduced by \`${f.test}\`, which fails now and must pass.`,
      "",
    ]),
    "## The gate",
    "",
    "Your change is kept only if every one of these exits 0, in this order, and",
    "at least one of the tests above passes afterwards:",
    "",
    ...gate.map((c) => `    ${c}`),
    "",
    ...contestInstructions(REVIEW_CONTEST_ID, contest),
    ...(previous ? ["", "## Your previous repair was discarded", "", "```", previous, "```"] : []),
  ].join("\n");
}

/**
 * Review, then repair what it proves broken, then look once more. Nothing
 * here parks: what is not repaired is reported first.
 */
export async function runReview(ctx: ReviewContext): Promise<ReviewOutcome> {
  const { id, env, archetype } = ctx;
  const dir = projectDir(id, env);

  const first = await runAgent(ctx, "review", loadPrompt("review"));
  if (first.limited) {
    discardPaths(dir, changedPaths(dir));
    return { outcome: "limit", stage: "review", limit: first.limited };
  }
  if (!first.ok) return { outcome: "failed", reason: `the review agent exited ${first.exitCode}` };

  let findings = triageFindings(ctx, findingsOrNone(id, env));
  writeFindings(id, findings, env);

  const judged = await adjudicateTestFindings(ctx, findings);
  if ("limit" in judged) {
    writeFindings(id, judged.findings, env);
    return { outcome: "limit", stage: judged.limit.stage, limit: judged.limit.limit };
  }
  findings = judged.findings;
  writeFindings(id, findings, env);

  const passed = (): Slice[] => {
    const ids = new Set(readState(id, env).slicesPassed);
    return readSlices(id, env).filter((s) => ids.has(s.id));
  };
  const reviewSlice: Slice = { id: REVIEW_CONTEST_ID, name: "review tests", criterionIds: ["(review)"], prerequisites: [] };

  let kept = false;
  let attempts = 0;
  let previous: string | null = null;
  const openFindings = (): Finding[] => findings.filter((f) => f.status === "open");

  while (openFindings().length > 0 && attempts < MAX_REVIEW_REPAIRS) {
    if (ctx.budgetExceeded()) {
      writeFindings(id, findings, env);
      return { outcome: "budget", stage: "review-repair" };
    }
    const repaired = findings.filter((f) => f.status === "repaired").map((f) => f.test as string);
    const gate = verifyRecipeFor(archetype).map((s) => [s.command, ...s.args].join(" "));
    const result = await runAgent(ctx, "review-repair", repairPrompt(openFindings(), gate, previous, contestFor(id, REVIEW_CONTEST_ID, env)));
    if (result.limited) {
      discardPaths(dir, changedPaths(dir));
      writeFindings(id, findings, env);
      return { outcome: "limit", stage: "review-repair", limit: result.limited };
    }

    const taken = takeContest(id, REVIEW_CONTEST_ID, env);
    if (taken.kind === "contest" && !contestFor(id, REVIEW_CONTEST_ID, env)) {
      discardPaths(dir, changedPaths(dir));
      const adjudicated = await adjudicate(
        adjudicationContext(ctx),
        reviewSlice,
        taken.contest,
        false,
      );
      if (adjudicated.kind === "limit") {
        writeFindings(id, findings, env);
        return { outcome: "limit", stage: adjudicated.stage, limit: adjudicated.limit };
      }
      continue;
    }

    attempts++;
    // Kept only if nothing built regresses, nothing already repaired breaks
    // again, and at least one more finding's test now passes. A fix for two
    // of three findings is progress, not a failure.
    const verdict = ctx.passedGate(id, archetype, passed(), env, repaired);
    const nowPassing = verdict.ok
      ? openFindings().filter((f) => ctx.runTests(id, archetype, [f.test as string], env).ok)
      : [];
    if (!verdict.ok || nowPassing.length === 0) {
      discardPaths(dir, changedPaths(dir));
      const step = verdict.steps.find((s) => !s.ok);
      previous = verdict.ok
        ? "The gate passed, but none of the findings' tests pass yet."
        : [verdict.reason ?? "", step?.output ? tail(step.output) : ""].filter(Boolean).join("\n");
      continue;
    }
    commitStage(id, "review-repair", env);
    const repairCommit = headCommit(dir);
    kept = true;
    previous = null;
    const fixed = new Set(nowPassing.map((f) => f.id));
    findings = findings.map((f) => (fixed.has(f.id) ? { ...f, status: "repaired", repairCommit } : f));
    writeFindings(id, findings, env);
  }

  findings = findings.map((f) =>
    f.status === "open" ? { ...f, status: "unrepaired", statusWhy: `still failing after ${attempts} repair attempt${attempts === 1 ? "" : "s"}` } : f,
  );
  writeFindings(id, findings, env);
  if (!kept) return { outcome: "complete" };

  await ctx.resmoke();

  // Round 2 reports what the repair may have broken or missed, and repairs
  // nothing: two reviews and one repair round, and then it is over.
  const second = await runAgent(
    ctx,
    "review-2",
    [
      loadPrompt("review"),
      "",
      "## This is the second round",
      "",
      "A repair round has already run against the first round's findings; their",
      "statuses are in `.sfo/FINDINGS.jsonl`. Look again, with fresh eyes, for",
      "anything the repair broke or the first round missed. Append new findings",
      "with `\"round\":2` and ids continuing past the highest `R-` in the file.",
      "Do not change existing lines. **Write no tests this round** — nothing",
      "will be repaired after it. Update `.sfo/REVIEW.md` with a section for this round.",
      "",
      "**If a repair caused a finding, say which.** Set `causedBy` to the id of the",
      "`repaired` finding whose repair introduced it (the repair's commit is in that",
      "line's `repairCommit`), and `null` otherwise. A `high` finding a repair",
      "caused rolls that repair back, restoring the code before it — so name a",
      "repair only when its change is the cause, not merely nearby.",
    ].join("\n"),
  );
  if (second.limited) {
    console.error("sfo: the plan limit stopped review's second round; its findings are those of the first");
  }
  discardPaths(dir, changedPaths(dir));
  const after = second.limited ? [] : findingsOrNone(id, env);
  const known = new Set(findings.map((f) => f.id));
  const added = after
    .filter((f) => f.round === 2 && !known.has(f.id))
    .map((f): Finding => ({ ...f, test: null, status: "report_only" }));
  writeFindings(id, rollBackRegressions(ctx, [...findings, ...added], passed), env);
  return { outcome: "complete" };
}

/**
 * A review that says a test is itself wrong has made a contest's case for it.
 * Filed with the adjudicator on the reviewer's behalf, because nothing else
 * may touch a locked test: on the first run to meet this, a smoke harness that
 * read its terminal after closing it failed on every attempt while review had
 * already said why.
 */
async function adjudicateTestFindings(
  ctx: ReviewContext,
  findings: Finding[],
): Promise<{ findings: Finding[] } | { findings: Finding[]; limit: { stage: string; limit: UsageLimit } }> {
  let out = findings.map((f) =>
    f.kind === "test" && f.status === "report_only" && f.round === 1 ? { ...f, status: "open" as const } : f,
  );
  const candidates = out.filter((f) => f.kind === "test" && f.status === "open" && f.testFile).slice(0, MAX_TEST_ADJUDICATIONS);
  for (const f of candidates) {
    const sliceId = `${REVIEW_CONTEST_ID}-${f.id}`;
    if (contestFor(ctx.id, sliceId, ctx.env)) continue;
    const outcome = await adjudicate(
      { ...adjudicationContext(ctx) },
      { id: sliceId, name: `test named by ${f.id}`, criterionIds: [f.criterionId ?? "(none)"], prerequisites: [] },
      {
        sliceId,
        criterionId: f.criterionId ?? "(none)",
        testFile: f.testFile as string,
        testName: "",
        claim: "unsatisfiable",
        why: `${f.summary}\n\n${f.evidence}`,
        proposedFix: "",
      },
      false,
    );
    if (outcome.kind === "limit") return { findings: out, limit: { stage: outcome.stage, limit: outcome.limit } };
    const ruling = contestFor(ctx.id, sliceId, ctx.env);
    out = out.map((g) =>
      g.id !== f.id
        ? g
        : ruling?.ruling === "amend_test"
          ? { ...g, status: "repaired", statusWhy: `the adjudicator amended ${f.testFile}` }
          : { ...g, status: "report_only", statusWhy: `the adjudicator upheld ${f.testFile}: ${ruling?.rulingWhy ?? "no ruling"}` },
    );
  }
  // Any beyond the cap, or naming no file, stay reported.
  return { findings: out.map((f) => (f.kind === "test" && f.status === "open" ? { ...f, status: "report_only" } : f)) };
}

function adjudicationContext(ctx: ReviewContext): AdjudicationContext {
  return {
    id: ctx.id,
    env: ctx.env,
    runner: ctx.runner,
    archetype: ctx.archetype,
    slices: readSlices(ctx.id, ctx.env),
    verify: ctx.verify,
    suiteCheck: ctx.suiteCheck,
    withHeartbeat: ctx.withHeartbeat,
  };
}

/**
 * Reverts each repair that round 2 says introduced a high-severity problem.
 * What comes back is the code before that repair: its original findings open
 * again, known and reported, instead of a new regression nobody asked for.
 */
function rollBackRegressions(ctx: ReviewContext, findings: Finding[], passed: () => Slice[]): Finding[] {
  const dir = projectDir(ctx.id, ctx.env);
  const byId = new Map(findings.map((f) => [f.id, f]));
  const culprits = new Map<string, string[]>();
  for (const f of findings) {
    if (f.round !== 2 || f.severity !== "high" || !f.causedBy) continue;
    const commit = byId.get(f.causedBy)?.repairCommit;
    if (!commit) continue;
    culprits.set(commit, [...(culprits.get(commit) ?? []), f.id]);
  }
  if (culprits.size === 0) return findings;

  let out = findings;
  for (const [commit, caused] of culprits) {
    const reverted = revertCommit(dir, commit);
    if (!reverted.ok) {
      console.error(`sfo: ${reverted.detail}; ${caused.join(", ")} stand as reported`);
      out = out.map((f) => (caused.includes(f.id) ? { ...f, statusWhy: `rollback failed — ${reverted.detail}` } : f));
      continue;
    }
    out = out.map((f) => {
      if (f.repairCommit === commit) {
        return { ...f, status: "unrepaired", statusWhy: `repair rolled back: it introduced ${caused.join(", ")}` };
      }
      if (caused.includes(f.id)) return { ...f, status: "rolled_back", statusWhy: `the repair that caused it was reverted (${reverted.detail})` };
      return f;
    });
  }

  const gate = ctx.passedGate(ctx.id, ctx.archetype, passed(), ctx.env);
  if (!gate.ok) {
    console.error(`sfo: after rolling back, the built slices no longer pass their gate — ${gate.reason ?? "see the verify output"}`);
  }
  return out;
}
