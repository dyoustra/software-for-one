import fs from "node:fs";
import path from "node:path";
import { readState, writeState, type ProjectState } from "./state.js";
import { holdAwake } from "./keepAwake.js";
import { nextStage, blocksOnHuman, recoveryHint } from "./stages.js";
import { artifactExists } from "./artifacts.js";
import { readCriteria, type Criterion } from "./criteria.js";
import { readSlices, nextRunnable, type Slice } from "./slices.js";
import { recordCost } from "./cost.js";
import { budgetState, formatBudget, type BudgetState } from "./budget.js";
import { readEstimate, formatEstimate, type Estimate } from "./estimate.js";
import { readDecisions, appendDecision } from "./decisions.js";
import { commitStage, discardPaths } from "./repo.js";
import { readPriorArt, blocksPipeline } from "./priorart.js";
import { lockTests, readTestLock, verifyTestLock } from "./testlock.js";
import { filesFor } from "./contracts.js";
import {
  runVerify,
  gateFor,
  checkRedBeforeBuild,
  runPassedGate,
  runTestFiles,
  agentToolsForStage,
  checkSuiteBeforeLock,
  detectArchetype,
  verifiabilityProblem,
  slicesWithoutTests,
  sliceTestFiles,
  TEST_DIR,
  type VerifyResult,
} from "./verify.js";
import { appendVerifyRecord } from "./verifyRecord.js";
import { loadPrompt } from "../stages/prompts.js";
import { projectDir, logPath, type Env } from "./paths.js";
import type { Runner, StageResult, UsageLimit } from "../runner/types.js";
import { writeLimit, clearLimit } from "./limit.js";
import { clearStopped, clearCrash, clearFailure, writeFailure } from "./stopped.js";
import { takeContest, contestFor, contestInstructions, type ContestRecord } from "./contest.js";
import { adjudicate, resumeCriterion, type AdjudicationContext, type AdjudicationOutcome } from "./adjudicate.js";
import { runSmoke, type SmokeDeps, type SmokeContext } from "./smoke.js";
import { runReview, type ReviewContext } from "./review.js";
import { installTool } from "./install.js";
import { captureRenders, drawDrafts } from "./presentation.js";
import { readRetry, clearRetry } from "./retry.js";

/** The artifact a human must produce before a blocking stage can run. */
const HUMAN_INPUT: Record<string, string> = { clarify: "ANSWERS.json" };

export const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Two, then the slice is abandoned along with everything downstream of it. A
 * third attempt is where an agent stops fixing the code and starts weakening
 * what it cannot satisfy.
 */
export const MAX_SLICE_ATTEMPTS = 2;

export type VerifyFn = (id: string, archetype: string, slice: Slice, env?: Env) => VerifyResult;
export type SuiteCheckFn = (id: string, env?: Env) => VerifyResult;
export type PassedGateFn = (
  id: string,
  archetype: string,
  passed: Slice[],
  env?: Env,
  extraTests?: string[],
) => VerifyResult;

export interface AdvanceOptions {
  /** Overridable so tests can exercise ticking without waiting 30s. */
  heartbeatMs?: number;
  /**
   * Injected for the same reason `Runner` is: the real gate shells out to a
   * project's toolchain, which a test of the slice loop has no business
   * installing. Production never passes it.
   */
  verify?: VerifyFn;
  /** The real-seam runs and credential reads of the smoke stage. Injected so tests make no real call. */
  smoke?: SmokeDeps;
  /** The gate a smoke or review repair must pass. Injected for the same reason as `verify`. */
  passedGate?: PassedGateFn;
  /** Draws spec's drafts for clarify. Injected for the same reason as `install`. */
  drawDrafts?: typeof drawDrafts;
  /** Captures and draws the tool's output. Injected for the same reason as `install`. */
  render?: typeof captureRenders;
  /** Red before the build. Injected for the same reason as `suiteCheck`. */
  redCheck?: typeof checkRedBeforeBuild;
  /** Puts the built tool on PATH. Injected so tests never install anything. */
  install?: typeof installTool;
  /** Runs chosen test files alone: review's reproductions. Injected for the same reason. */
  runTests?: ReviewContext["runTests"];
  /** The pre-lock check on test-repair's output. Injected for the same reason. */
  suiteCheck?: SuiteCheckFn;
}

/**
 * Keeps `heartbeatAt` fresh for the duration of a stage. Stamping it once at
 * stage start is not enough: real stages run for minutes, `isStale` uses a
 * 120s window, and a healthy long run would therefore read as dead to
 * `sfo status` and to the already-running guard in `sfo run`.
 */
export function startHeartbeat(id: string, env: Env | undefined, intervalMs: number): () => void {
  holdAwake(id);
  const timer = setInterval(() => {
    holdAwake(id);
    try {
      const current = readState(id, env);
      writeState({ ...current, heartbeatAt: new Date().toISOString() }, env);
    } catch {
      // State was unreadable this tick (mid-rename, say). The next tick retries;
      // a missed beat is survivable, a crashed heartbeat thread is not.
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * What has to follow test-repair, however it ran — in a run, or on its own
 * with \`sfo stage\`: the suite must load and pass its unscoped gate steps,
 * must fail against the skeleton, and is then hash-locked. Returns why it
 * cannot be locked, or null once it is.
 *
 * Freezing the suite is what makes every later gate mean anything: from here
 * the build is graded against tests it cannot renegotiate. A test-repair
 * re-run by hand once skipped all of this, and a whole build was graded
 * against nothing.
 */
export function sealSuite(
  id: string,
  env: Env | undefined,
  checks: { suiteCheck?: SuiteCheckFn; redCheck?: typeof checkRedBeforeBuild } = {},
): string | null {
  const checked = (checks.suiteCheck ?? checkSuiteBeforeLock)(id, env);
  if (!checked.ok) {
    const failed = checked.steps.find((st) => !st.ok);
    const detail = failed?.output.trim().split("\n").slice(-15).join("\n") ?? "";
    return (
      `test-repair left a suite that does not pass ${failed?.name ?? "the gate"} — ` +
      `${checked.reason ?? "check failed"}. It is not locked, because no build ` +
      `slice could fix it afterwards. Re-run \`sfo stage ${id} test-repair\`.` +
      (detail ? `\n${detail}` : "")
    );
  }
  const red = (checks.redCheck ?? checkRedBeforeBuild)(id, env);
  if (red.checked.length > 0 && red.greenOnSkeleton.length === red.checked.length) {
    return (
      `the gate passes on the unbuilt skeleton for every slice (${red.checked.join(", ")}), so it tests nothing — ` +
      `check the scoped steps in .sfo/CONTRACTS.json and re-run \`sfo stage ${id} test-repair\``
    );
  }
  if (red.greenOnSkeleton.length > 0) {
    console.error(`sfo: ${red.greenOnSkeleton.join(", ")} already pass against the skeleton; building anyway`);
  }

  // \`lockTests\` refuses an empty tree, and that refusal is fatal rather than
  // skipped: an empty tree means test-write produced nothing, so there is no
  // contract to build against.
  try {
    lockTests(id, TEST_DIR, env);
  } catch (err) {
    return `cannot freeze the test suite — ${reason(err)}. Re-run \`sfo stage ${id} test-write\`.`;
  }
  return null;
}

/**
 * Stop and wait for the human rather than running anything, and why.
 *
 * Both reasons halt the pipeline, but they ask different things of the user —
 * "answer my questions" versus "raise the ceiling or take what is built" — so
 * the reason has to survive as far as the caller, not collapse to one sentinel.
 */
type Park =
  | { park: "human" }
  /** `stage` is the one that was refused, not the one that last ran. */
  | { park: "budget"; stage: string; budget: BudgetState }
  /** The build has not started and, on the plan's own numbers, cannot finish. */
  | { park: "estimate"; budget: BudgetState; estimate: Estimate }
  /**
   * A subscription's usage window ran out mid-stage. Not a failure: the stage
   * did nothing wrong, and counting it would fail a project for the time of day.
   */
  | { park: "limit"; stage: string; limit: UsageLimit }
  /** The adjudicator found a criterion at fault, and only the person can say what it meant. */
  | { park: "criterion"; sliceId: string; criterionId: string; questionId: string };

const HUMAN_PARK: Park = { park: "human" };

function isPark(pick: string | null | Park): pick is Park {
  return pick !== null && typeof pick === "object";
}

/** What to run next, or the reason nothing runs. */
function pickStage(
  id: string,
  state: ProjectState,
  env: Env | undefined,
): string | null | Park {
  const target = pickTarget(id, state, env);
  if (!isPark(target) && target !== null) {
    // Checked here, before dispatch, and never after recording what a stage
    // cost. Charging first and checking afterwards overshoots by exactly one
    // stage every time, and a stage costs the same order as a small ceiling.
    const budget = budgetState(id, env);
    if (budget?.exceeded) return { park: "budget", stage: target, budget };
    if (budget && target === FIRST_ESTIMATED_STAGE) {
      const planned = readEstimate(id, env).filter((e) => e.phase === "build").at(-1);
      if (planned && planned.lowUsd > budget.remaining) {
        return { park: "estimate", budget, estimate: planned };
      }
    }
  }
  return target;
}

/**
 * The plan's estimate covers everything after `plan`, so it is checked before
 * the first of those stages. It used to be checked at the start of `build`,
 * after test-write and test-repair had already run. On the first real project
 * test-write alone cost $11.73, more than every stage before it, and none of
 * it was in the estimate or seen by the check.
 *
 * Only the low end parks: low > remaining means the rest cannot finish at this
 * ceiling. When the range straddles what is left, the per-stage and per-slice
 * checks stop it at a boundary with the work so far kept.
 */
const FIRST_ESTIMATED_STAGE = "test-write";

/**
 * Decides what to run next, and the parked case is the subtle one.
 *
 * A human stage is reached in two distinct states, and only handling the first
 * silently skips the stage. Advancing INTO `clarify` with no answers yet parks
 * — that much was always right. But once parked, `currentStage` IS `clarify`,
 * so asking `nextStage(currentStage)` returns null and the project is marked
 * done having never folded the human's answers into the spec. The parked stage
 * has to be re-selected as the target, not stepped over.
 *
 * Re-running it is not a risk: running sets status to `running`, and the parked
 * branch requires `awaiting_human`, so the stage cannot select itself twice.
 */
function pickTarget(
  id: string,
  state: ProjectState,
  env: Env | undefined,
): string | null | Park {
  const current = state.currentStage;

  // A run that died mid-stage: it is still marked running, and the stage it
  // was on never finished. Stepping to the next stage would skip it.
  if (state.status === "running" && state.completedStage !== current && current !== "capture") {
    return current;
  }

  if (
    blocksOnHuman(current) &&
    state.status === "awaiting_human" &&
    artifactExists(id, HUMAN_INPUT[current], env)
  ) {
    return current;
  }

  // `build` is the one stage that can be half-done. Its slice loop parks on the
  // budget and can be killed mid-slice, and in both cases `currentStage` is
  // already "build" — so the ordinary `nextStage` answer is "review", which
  // would step over every slice still unbuilt and let the later stages report
  // on work that never happened.
  if (current === "build" && buildUnfinished(id, state, env)) return "build";

  const upcoming = nextStage(current);
  if (upcoming === null) return null;

  if (blocksOnHuman(upcoming) && !artifactExists(id, HUMAN_INPUT[upcoming], env)) {
    return HUMAN_PARK;
  }
  return upcoming;
}

/**
 * A halt the user has to act on and pay for is a decision, so it belongs in the
 * trace with the numbers that forced it. The id encodes the stage and the
 * ceiling that stopped it: re-running `sfo run` against an unchanged ceiling
 * must not append the same halt again, while raising the ceiling and hitting it
 * a second time is a genuinely new event and gets its own record.
 */
function recordBudgetPark(
  id: string,
  stage: string,
  budget: BudgetState,
  env: Env | undefined,
): void {
  const decisionId = `D-budget-${stage}-${budget.ceiling}`;
  try {
    if (readDecisions(id, env).some((d) => d.id === decisionId)) return;
  } catch {
    // A stage writes this file too, so a malformed one is possible. Losing the
    // trace is better than letting it stop the pipeline from parking.
    return;
  }

  appendDecision(
    id,
    {
      id: decisionId,
      decision: `Whether to run "${stage}" with the budget ceiling already spent`,
      chose: "park the project and hand the call back to the human",
      considered: "run the stage anyway; abandon the project",
      why: `${formatBudget(budget)} — raise it with \`sfo budget ${id} <usd>\` or take what is already built`,
      decided_by: "agent",
      // The user's money and their delivery, not an internal detail.
      blast_radius: "external",
      at: new Date().toISOString(),
    },
    env,
  );
}


/**
 * Records a build refused before it started. Kept distinct from a mid-build
 * budget park: nothing has been spent on the build, so the choice on offer is
 * different — raise the ceiling and get the whole thing, or stop now having
 * paid only for the front half.
 */
function recordEstimatePark(
  id: string,
  estimate: Estimate,
  budget: BudgetState,
  env: Env | undefined,
): void {
  const decisionId = `D-estimate-${budget.ceiling}-${estimate.lowUsd}`;
  try {
    if (readDecisions(id, env).some((d) => d.id === decisionId)) return;
  } catch {
    return;
  }

  appendDecision(
    id,
    {
      id: decisionId,
      decision: "Whether to start test-write and the build when the ceiling cannot cover them",
      chose: "park after plan and hand the call back to the human",
      considered: "build until the ceiling stops it part-way; abandon the project",
      why:
        `${formatEstimate(estimate)}; ${formatBudget(budget)}. Even the low end exceeds ` +
        `what is left, so the project would stop part-built. Raise it with ` +
        `\`sfo budget ${id} <usd>\`, or stop here having paid only for the plan.`,
      decided_by: "agent",
      blast_radius: "external",
      at: new Date().toISOString(),
    },
    env,
  );
}

/**
 * Criterion ids currently on disk. Never throws: this feeds a drift *warning*,
 * and a check that can fail the pipeline is worse than the drift it detects.
 */
function criterionIds(id: string, env: Env | undefined): string[] {
  try {
    return readCriteria(id, env).map((c) => c.id);
  } catch {
    return [];
  }
}

/**
 * Stages that rewrite CRITERIA.jsonl must re-emit every record to change one,
 * and a model can drop records from the untouched tail of a long rewrite.
 * That failure is silent — a vanished criterion just shrinks the contract the
 * build is held to, and nothing throws. Removal is sometimes legitimate (an
 * answer can rule a criterion out), so this warns rather than fails, but it
 * makes the shrink visible instead of invisible.
 */
function warnOnDroppedCriteria(before: string[], after: string[], stage: string): void {
  if (before.length === 0) return;
  const surviving = new Set(after);
  const dropped = before.filter((x) => !surviving.has(x));
  if (dropped.length > 0) {
    console.warn(
      `sfo: ${stage} dropped ${dropped.length} criteri${dropped.length === 1 ? "on" : "a"}: ${dropped.join(", ")}`,
    );
  }
}

/** Is there still a slice that could be built? */
function buildUnfinished(id: string, state: ProjectState, env: Env | undefined): boolean {
  try {
    const progress = { passed: state.slicesPassed, failed: state.slicesFailed };
    return nextRunnable(readSlices(id, env), progress) !== null;
  } catch {
    // A malformed SLICES.jsonl means nobody can say what is built. Re-entering
    // build fails loudly there instead of letting review pass over it.
    return true;
  }
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Fails the project at `stage`, and writes down why. Printing was not enough:
 * a detached run's output is discarded, so a failure with only a console line
 * read as "failed" with no reason anywhere a person could find it.
 */
function fail(id: string, state: ProjectState, stage: string, why: string, env: Env | undefined): ProjectState {
  console.error(`sfo: ${why}`);
  writeFailure(id, { stage, reason: why, at: new Date().toISOString() }, env);
  const failed = failedState(state, stage);
  writeState(failed, env);
  return failed;
}

/** The state a stage that could not complete leaves behind. */
function failedState(state: ProjectState, stage: string): ProjectState {
  return {
    ...state,
    status: "failed",
    pid: null,
    attempts: { ...state.attempts, [stage]: (state.attempts[stage] ?? 0) + 1 },
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Stops the project and records why. A human park moves onto the stage that is
 * waiting for the human; a budget park stays where it is, because the picked
 * stage never ran and marking it current would make the next `pickStage` ask
 * for the one after it — silently skipping work the ceiling only postponed.
 */
function applyPark(id: string, state: ProjectState, park: Park, env: Env | undefined): void {
  const target =
    park.park === "human"
      ? (nextStage(state.currentStage) ?? state.currentStage)
      : state.currentStage;
  writeState(
    {
      ...state,
      currentStage: target,
      status: "awaiting_human",
      pid: null,
      updatedAt: new Date().toISOString(),
    },
    env,
  );
  if (park.park === "budget") recordBudgetPark(id, park.stage, park.budget, env);
  if (park.park === "estimate") recordEstimatePark(id, park.estimate, park.budget, env);
  if (park.park === "limit") {
    writeLimit(id, { stage: park.stage, ...park.limit, at: new Date().toISOString() }, env);
  }
}

/**
 * `loadPrompt("build")` is the same text for every slice; the agent still has
 * to be told which slice is its own. The criteria are appended rather than
 * left to be looked up, so "make exactly these pass" is unambiguous.
 */
function buildPromptFor(
  slice: Slice,
  criteria: Criterion[],
  gate: string[],
  previousFailure: string | null,
  contest: ContestRecord | undefined,
): string {
  const mine = criteria.filter((c) => slice.criterionIds.includes(c.id));
  return [
    loadPrompt("build"),
    "",
    `## Your slice: ${slice.id} — ${slice.name}`,
    "",
    "Make exactly these criteria pass:",
    "",
    ...mine.map((c) => `- ${c.id}: ${c.text}`),
    "",
    // Told only to format, the first real slice formatted and then failed lint
    // on six errors `ruff --fix` would have cleared. The agent can run the gate
    // itself, so it is given the gate rather than a description of it.
    "## The gate",
    "",
    "Your work is accepted only if every one of these exits 0, in this order.",
    "Run them yourself before you finish:",
    "",
    ...gate.map((command) => `    ${command}`),
    "",
    ...contestInstructions(slice.id, contest),
    ...(previousFailure
      ? [
          "",
          // Without this a retry starts from the same prompt as the attempt that
          // failed, and can only rediscover the failure by failing again.
          "## Your previous attempt at this slice failed the gate",
          "",
          "Fix what this reports. The code from that attempt is still in the tree.",
          "",
          "```",
          previousFailure,
          "```",
        ]
      : []),
  ].join("\n");
}

/** The commands the gate will run for this slice, as a person would type them. */
function gateCommands(id: string, archetype: string, slice: Slice, env: Env | undefined): string[] {
  return gateFor(id, env, archetype).flatMap((step) => {
    if (!step.scopeable) return [[step.command, ...step.args].join(" ")];
    const files = filesFor(id, step, slice.id, env);
    // Skipped by the gate when the slice has none, so not shown either.
    return files.length > 0 ? [[step.command, ...step.args, ...files].join(" ")] : [];
  });
}

/** Lines of the last failed gate run given to a retry: enough to act on. */
const FAILURE_EXCERPT_LINES = 80;

/**
 * The last gate run for this slice, if it failed. The verify log is appended
 * one block per attempt, each starting with a `--- <time> pass|fail` line.
 */
function previousFailureFor(id: string, stageName: string, env: Env | undefined): string | null {
  try {
    const text = fs.readFileSync(logPath(id, `${stageName}.verify`, env), "utf8");
    const start = text.lastIndexOf("--- ");
    if (start === -1) return null;
    const block = text.slice(start).split("\n");
    if (!block[0]?.endsWith(" fail")) return null;
    return block.slice(1, 1 + FAILURE_EXCERPT_LINES).join("\n").trim();
  } catch {
    return null;
  }
}

/**
 * A slice that fails the gate is worth nothing without the output that says
 * why, and the agent's own log ends before verification starts. Appended, not
 * overwritten: the second attempt's failure is rarely the first one's.
 */
function writeVerifyLog(
  id: string,
  stageName: string,
  verdict: VerifyResult,
  env: Env | undefined,
): void {
  const lines = [
    `--- ${new Date().toISOString()} ${verdict.ok ? "pass" : "fail"}`,
    ...(verdict.reason ? [verdict.reason] : []),
    ...verdict.steps.map((s) =>
      s.ok ? `[ok] ${s.name}` : `[exit ${s.exitCode ?? "could not run"}] ${s.name}\n${s.output}`,
    ),
    "",
  ];
  try {
    const file = logPath(id, `${stageName}.verify`, env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, lines.join("\n"));
  } catch {
    // Diagnostics must never cost the build the result they describe.
  }
}

function failedVerdict(why: string): VerifyResult {
  return { ok: false, steps: [], tamperedTests: [], reason: why };
}

/**
 * One slice attempt's verdict, and the archetype it was graded as.
 *
 * The archetype is resolved per attempt rather than once for the run: on a
 * project with no recorded archetype, the first slice can be the one that
 * writes the manifest it is recognised by. `runSlices` has already rejected a
 * malformed record before any slice ran, so a throw here means something
 * rewrote it mid-build — that fails the slice, not the whole run.
 */
function gradeAttempt(
  id: string,
  slice: Slice,
  result: StageResult,
  verify: VerifyFn,
  env: Env | undefined,
): { archetype: string; verdict: VerifyResult } {
  let archetype = "unknown";
  try {
    archetype = detectArchetype(id, env);
  } catch (err) {
    return { archetype, verdict: failedVerdict(reason(err)) };
  }

  if (!result.ok) {
    return { archetype, verdict: failedVerdict(`the build agent exited ${result.exitCode}`) };
  }
  return { archetype, verdict: verify(id, archetype, slice, env) };
}

/**
 * The structured account of the gate, which `.sfo/logs/*.verify.log` is not:
 * that log is gitignored and unstructured, and the deliver stage has to lead
 * with what does not work. Best-effort like the log — losing the record must
 * not cost the build the result it describes — but it complains, because a
 * missing record is indistinguishable from a slice that never ran.
 */
function recordVerdict(
  id: string,
  slice: Slice,
  archetype: string,
  attempt: number,
  verdict: VerifyResult,
  env: Env | undefined,
): void {
  try {
    appendVerifyRecord(
      id,
      {
        slice: slice.id,
        attempt,
        ok: verdict.ok,
        archetype,
        failedStep: verdict.steps.find((step) => !step.ok)?.name,
        reason: verdict.reason,
        tamperedTests: verdict.tamperedTests,
        at: new Date().toISOString(),
      },
      env,
    );
  } catch (err) {
    console.error(`sfo: could not record the verify result for ${slice.id} — ${reason(err)}`);
  }
}

/** The park an adjudication ends in, if it ends in one. */
function parkFor(outcome: AdjudicationOutcome): Park | null {
  if (outcome.kind === "limit") return { park: "limit", stage: outcome.stage, limit: outcome.limit };
  if (outcome.kind === "criterion") {
    const { sliceId, criterionId, questionId } = outcome;
    return { park: "criterion", sliceId, criterionId, questionId };
  }
  return null;
}

type BuildOutcome =
  | { outcome: "complete" }
  | { outcome: "parked"; park: Park }
  | { outcome: "failed"; reason: string };

/**
 * Builds one slice at a time, verifying each before moving on.
 *
 * State is persisted after every slice, which is the entire reason the pipeline
 * slices at all: a run killed by a dropped connection resumes at the next
 * unbuilt slice instead of paying again for the ones that already passed.
 */
async function runSlices(
  id: string,
  runner: Runner,
  env: Env | undefined,
  heartbeatMs: number,
  verify: VerifyFn,
  suiteCheck: SuiteCheckFn,
): Promise<BuildOutcome> {
  let slices: Slice[];
  let criteria: Criterion[];
  try {
    slices = readSlices(id, env);
    criteria = readCriteria(id, env);
  } catch (err) {
    return { outcome: "failed", reason: `${reason(err)} — re-run \`sfo stage ${id} plan\`` };
  }

  // Nothing to build is not "done": every criterion is supposed to live in
  // exactly one slice, so an empty plan means the build would deliver nothing
  // while every later stage reported success.
  if (slices.length === 0) {
    return { outcome: "failed", reason: `no slices to build — re-run \`sfo stage ${id} plan\`` };
  }

  // An archetype nobody registered has no recipe, so every slice would report
  // "no gates available" and fail twice before anyone learned that the one
  // stage that picks the stack picked a stack this cannot grade.
  let archetype: string;
  try {
    archetype = detectArchetype(id, env);
  } catch (err) {
    return { outcome: "failed", reason: `${reason(err)} — re-run \`sfo stage ${id} spec\`` };
  }

  // Everything that can stop a build is checked here, once, before any slice
  // is paid for — and reported together rather than one at a time. Each would
  // otherwise present as an ordinary slice failure, indistinguishable from
  // code that does not work, and cost two attempts on every slice to say so.
  // They are collected because they have different remedies: told only the
  // first, the user fixes it, pays for another run, and meets the second.
  const blockers: string[] = [];

  // test-repair is the stage that scaffolds the toolchain.
  const unverifiable = verifiabilityProblem(id, archetype, env);
  if (unverifiable) {
    blockers.push(`${unverifiable} — re-run \`sfo stage ${id} test-repair\``);
  }

  // The suite is hash-locked by now, so this answer cannot change mid-build. A
  // slice whose tests cannot be found is a broken contract between test-write
  // and the gate, and one re-run of test-write fixes every one of them — which
  // is only possible if they are all named here rather than met one at a time.
  const untested = slicesWithoutTests(id, slices, env);
  if (untested.length > 0) {
    blockers.push(
      `no test file under ${TEST_DIR}/ is named for ${untested.join(", ")} — ` +
        `re-run \`sfo stage ${id} test-write\` so every slice has a test file named for its id`,
    );
  }

  // Without a lock the gate refuses every slice, so the build would fail each
  // one twice and the run would carry on into smoke and review of code that
  // nothing graded.
  if (Object.keys(readTestLock(id, env)).length === 0) {
    blockers.push(`the test suite was never locked — re-run \`sfo stage ${id} test-repair\``);
  }

  if (blockers.length > 0) return { outcome: "failed", reason: blockers.join("; ") };

  const ctx: AdjudicationContext = {
    id,
    env,
    runner,
    archetype,
    slices,
    verify,
    suiteCheck,
    withHeartbeat: async (fn) => {
      const stop = startHeartbeat(id, env, heartbeatMs);
      try {
        return await fn();
      } finally {
        stop();
      }
    },
  };

  // A criterion parked for the person is settled before any slice runs: the
  // answer can change the suite every slice is graded against.
  const resumed = await resumeCriterion(ctx);
  const resumedPark = resumed && parkFor(resumed);
  if (resumedPark) return { outcome: "parked", park: resumedPark };

  while (true) {
    let state = readState(id, env);
    const slice = nextRunnable(slices, {
      passed: state.slicesPassed,
      failed: state.slicesFailed,
    });
    if (!slice) return { outcome: "complete" };

    const stageName = `build-${slice.id}`;

    // Checked before spending, not after. A ceiling discovered post-hoc is a
    // report, not a limit.
    const budget = budgetState(id, env);
    if (budget?.exceeded) {
      return { outcome: "parked", park: { park: "budget", stage: stageName, budget } };
    }

    const stopHeartbeat = startHeartbeat(id, env, heartbeatMs);
    let result;
    try {
      result = await runner.runStage({
        workdir: projectDir(id, env),
        prompt: buildPromptFor(
          slice,
          criteria,
          gateCommands(id, archetype, slice, env),
          previousFailureFor(id, stageName, env),
          contestFor(id, slice.id, env),
        ),
        logPath: logPath(id, stageName, env),
        allowedTools: agentToolsForStage(id, stageName, env),
      });
    } finally {
      stopHeartbeat();
    }
    recordCost(id, stageName, result.ok, result.usage, env, "cli", result.billing);

    // Before grading: the slice's half-written code stays in the tree for the
    // resumed attempt, which is exactly what a retry would get.
    if (result.limited) {
      return { outcome: "parked", park: { park: "limit", stage: stageName, limit: result.limited } };
    }

    // A contest is read before the gate: the agent stopped on purpose, and
    // grading its unfinished tree would record a failure that is not one. A
    // slice gets one; a second is ignored and the gate is the answer.
    const taken = takeContest(id, slice.id, env);
    if (taken.kind === "contest" && !contestFor(id, slice.id, env)) {
      const park = parkFor(await adjudicate(ctx, slice, taken.contest));
      if (park) return { outcome: "parked", park };
      continue;
    }

    const { archetype: gradedAs, verdict } =
      taken.kind === "invalid"
        ? { archetype, verdict: failedVerdict(`the contest could not be read: ${taken.reason}`) }
        : gradeAttempt(id, slice, result, verify, env);
    writeVerifyLog(id, stageName, verdict, env);

    // The heartbeat rewrote state under us while the slice ran.
    state = readState(id, env);
    recordVerdict(id, slice, gradedAs, (state.sliceAttempts[slice.id] ?? 0) + 1, verdict, env);

    if (verdict.ok) {
      writeState(
        {
          ...state,
          slicesPassed: [...state.slicesPassed, slice.id],
          updatedAt: new Date().toISOString(),
        },
        env,
      );
      commitStage(id, stageName, env);
      continue;
    }

    const attempts = (state.sliceAttempts[slice.id] ?? 0) + 1;
    writeState(
      {
        ...state,
        sliceAttempts: { ...state.sliceAttempts, [slice.id]: attempts },
        slicesFailed:
          attempts >= MAX_SLICE_ATTEMPTS ? [...state.slicesFailed, slice.id] : state.slicesFailed,
        updatedAt: new Date().toISOString(),
      },
      env,
    );

    // Failing again on a retry: the same inputs got the same answer, so the
    // test, not the code, may be what is wrong. ut-tower's S-13 failed three
    // runs in a row on a helper review had twice called broken.
    if (attempts >= MAX_SLICE_ATTEMPTS && readRetry(id, env)?.slices.includes(slice.id)) {
      const second = await secondOpinion(ctx, slice, verdict, id, env);
      if (typeof second === "object") return { outcome: "parked", park: { park: "limit", stage: second.stage, limit: second.limit } };
      if (second === "amended") {
        const now = readState(id, env);
        const sliceAttempts = { ...now.sliceAttempts };
        delete sliceAttempts[slice.id];
        writeState({ ...now, slicesFailed: now.slicesFailed.filter((s) => s !== slice.id), sliceAttempts, updatedAt: new Date().toISOString() }, env);
      }
    }
  }
}

/** The first test file a failed gate names, as pytest or vitest prints it. */
function failingTestFile(verdict: VerifyResult): string | null {
  const output = verdict.steps.map((s) => s.output).join("\n");
  return output.match(/FAILED ([^\s:]+)::/)?.[1] ?? output.match(/FAIL\s+([^\s>]+\.test\.[cm]?[jt]s)/)?.[1] ?? null;
}

/**
 * Sends a retried slice's failing test to the adjudicator, once. The whole
 * test tree is in view there, helpers included, which is where ut-tower's
 * defect lived.
 */
async function secondOpinion(
  ctx: AdjudicationContext,
  slice: Slice,
  verdict: VerifyResult,
  id: string,
  env: Env | undefined,
): Promise<"amended" | "upheld" | "none" | { stage: string; limit: UsageLimit }> {
  const contestId = `${slice.id}-retry`;
  const testFile = failingTestFile(verdict) ?? sliceTestFiles(id, slice, env)[0];
  if (!testFile || contestFor(id, contestId, env)) return "none";
  const detail = verdict.steps.find((s) => !s.ok)?.output.trim().split("\n").slice(-40).join("\n") ?? verdict.reason ?? "";
  const outcome = await adjudicate(
    ctx,
    { ...slice, id: contestId },
    {
      sliceId: contestId,
      criterionId: slice.criterionIds[0] ?? "(none)",
      testFile,
      testName: "",
      claim: "unsatisfiable",
      why: `${slice.id} failed its gate on a retry exactly as it had before. Decide whether this test, or a helper it uses, rather than the code, is wrong.\n\n${detail}`,
      proposedFix: "",
    },
    false,
  );
  if (outcome.kind === "limit") return { stage: outcome.stage, limit: outcome.limit };
  return contestFor(id, contestId, env)?.ruling === "amend_test" ? "amended" : "upheld";
}

export async function advance(
  id: string,
  runner: Runner,
  env?: Env,
  opts: AdvanceOptions = {},
): Promise<void> {
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_INTERVAL_MS;
  let state = readState(id, env);

  // `done` was written against the pipeline as it was at the time. Every
  // project that finished Phase 1 is `done` at `clarify`, which is no longer
  // the last stage. Returning here would leave them all unable to continue,
  // so `done` only counts when nothing follows the stage it was recorded at.
  if (state.status === "done" && nextStage(state.currentStage) === null) return;

  // Refusing to advance a failed project closes two data-loss paths. Advancing
  // past a failed stage would silently skip the work it never finished, and a
  // failed `clarify` would fall straight through `nextStage() === null` and be
  // marked `done` — reporting success for a spec that never absorbed the
  // human's answers. `currentStage` alone cannot distinguish "resume this" from
  // "advance past this", so the status has to be the gate.
  if (state.status === "failed") {
    throw new Error(
      `${id} failed at stage "${state.currentStage}" — ${recoveryHint(id, state.currentStage)}`,
    );
  }

  // A run starting is the answer to a limit park, whether the window reset or
  // the human switched credentials. If it is hit again it is written again.
  clearLimit(id, env);
  clearStopped(id, env);
  clearCrash(id, env);
  clearFailure(id, env);

  while (true) {
    const upcoming = pickStage(id, state, env);

    if (upcoming === null) {
      state = { ...state, status: "done", pid: null, updatedAt: new Date().toISOString() };
      writeState(state, env);
      return;
    }

    if (isPark(upcoming)) {
      applyPark(id, state, upcoming, env);
      return;
    }

    const previousStage = state.currentStage;
    state = {
      ...state,
      currentStage: upcoming,
      status: "running",
      pid: process.pid,
      heartbeatAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    writeState(state, env);

    // `build` is not one call to an agent but a loop over slices, each verified
    // as it lands. Verification is deliberately not a stage of its own: a slice
    // that builds and fails its gate must not be able to reach a later stage
    // that reports otherwise.
    if (upcoming === "build") {
      const built = await runSlices(
        id,
        runner,
        env,
        heartbeatMs,
        opts.verify ?? runVerify,
        opts.suiteCheck ?? checkSuiteBeforeLock,
      );
      state = readState(id, env);

      if (built.outcome === "parked") {
        applyPark(id, state, built.park, env);
        return;
      }
      if (built.outcome === "failed") {
        fail(id, state, upcoming, `build cannot start — ${built.reason}`, env);
        return;
      }

      // A failed slice's changes to the suite are tampering, whatever their
      // intent, and committed they poison every later stage's lock check. The
      // first project to hit this had a slice capture 262 fixtures into
      // tests/; smoke then refused a suite that no longer matched its lock.
      const drift = verifyTestLock(id, TEST_DIR, env);
      if (drift.length > 0) {
        discardPaths(projectDir(id, env), drift);
        console.error(`sfo: discarded changes to the locked suite left by failed slices: ${drift.slice(0, 5).join(", ")}${drift.length > 5 ? ` and ${drift.length - 5} more` : ""}`);
      }

      // Each passing slice committed itself; this catches the state left by any
      // that failed, so what was abandoned is in the history too.
      commitStage(id, upcoming, env);
      state = markCompleted(id, upcoming, env);
      continue;
    }

    // Smoke exercises the real seams and review hunts for hollow behaviour,
    // and each can repair what it proves broken. Both are loops with their own
    // bounds rather than one agent call, so they are dispatched here.
    if (upcoming === "smoke" || upcoming === "review") {
      let archetype: string;
      try {
        archetype = detectArchetype(id, env);
      } catch (err) {
        fail(id, readState(id, env), upcoming, `${upcoming} cannot run — ${reason(err)}`, env);
        return;
      }
      const smokeCtx: SmokeContext = {
        id,
        env,
        runner,
        archetype,
        verify: opts.verify ?? runVerify,
        suiteCheck: opts.suiteCheck ?? checkSuiteBeforeLock,
        passedGate: opts.passedGate ?? runPassedGate,
        budgetExceeded: () => budgetState(id, env)?.exceeded ?? false,
        withHeartbeat: async (fn) => {
          const stop = startHeartbeat(id, env, heartbeatMs);
          try {
            return await fn();
          } finally {
            stop();
          }
        },
        deps: opts.smoke,
      };
      // A retry redoes only what failed. Rebuilt slices changed the code, so
      // then every seam and a full review run again; otherwise just the
      // failed seams, and a repair round for the unrepaired findings — or,
      // with none of those, no review at all.
      const retry = readRetry(id, env);
      const narrow = retry !== null && retry.slices.length === 0;
      if (upcoming === "review" && narrow && retry.findings.length === 0) {
        commitStage(id, upcoming, env);
        state = markCompleted(id, upcoming, env);
        continue;
      }
      const ran =
        upcoming === "smoke"
          ? await runSmoke({ ...smokeCtx, ...(narrow ? { onlySeams: retry.seams } : {}) })
          : await runReview({
              ...smokeCtx,
              runTests: opts.runTests ?? runTestFiles,
              resmoke: async () => {
                await runSmoke({ ...smokeCtx, noRepair: true });
              },
              ...(narrow ? { retryFindings: retry.findings } : {}),
            });
      state = readState(id, env);

      if (ran.outcome === "failed") {
        fail(id, state, upcoming, `${upcoming} cannot run — ${ran.reason}`, env);
        return;
      }
      // Parked from the stage before, so the next run repeats this one whole.
      // What a half-finished repair produced has already been kept or discarded.
      const budget = budgetState(id, env);
      const park: Park | null =
        ran.outcome === "limit"
          ? { park: "limit", stage: ran.stage, limit: ran.limit }
          : ran.outcome === "budget" && budget
            ? { park: "budget", stage: ran.stage, budget }
            : null;
      if (park) {
        applyPark(id, { ...state, currentStage: previousStage }, park, env);
        return;
      }
      // What the tool looks like, for review to see and the summary to show.
      // After smoke, because the code is final for the seams by then.
      if (upcoming === "smoke") {
        try {
          (opts.render ?? captureRenders)(id, archetype, env ?? process.env);
        } catch (err) {
          console.error(`sfo: could not capture the tool's output — ${reason(err)}`);
        }
      }
      commitStage(id, upcoming, env);
      state = markCompleted(id, upcoming, env);
      continue;
    }

    // The tool goes on the person's PATH before the summary is written, so the
    // summary can say how to run it — or plainly why it could not be installed.
    if (upcoming === "deliver") {
      try {
        (opts.install ?? installTool)(id, detectArchetype(id, env), env ?? process.env);
      } catch (err) {
        console.error(`sfo: could not install the tool — ${reason(err)}`);
      }
    }

    const criteriaBefore = criterionIds(id, env);
    const stopHeartbeat = startHeartbeat(id, env, heartbeatMs);
    let result;
    try {
      result = await runner.runStage({
        workdir: projectDir(id, env),
        prompt: loadPrompt(upcoming),
        logPath: logPath(id, upcoming, env),
        allowedTools: agentToolsForStage(id, upcoming, env),
      });
    } finally {
      stopHeartbeat();
    }

    // Recorded before the ok/failed branch: a stage that failed still spent
    // money, and billing only the happy path under-reports every retry.
    recordCost(id, upcoming, result.ok, result.usage, env, "cli", result.billing);

    warnOnDroppedCriteria(criteriaBefore, criterionIds(id, env), upcoming);

    // The heartbeat rewrote state under us, so re-read before mutating rather
    // than writing back a stale in-memory copy.
    state = readState(id, env);

    // Parked from the stage before, as a budget park is: `currentStage` is the
    // last one finished, and left at the interrupted one, the next run would
    // pick the stage after it and never repeat the work the limit cut short.
    if (result.limited) {
      const limit: Park = { park: "limit", stage: upcoming, limit: result.limited };
      applyPark(id, { ...state, currentStage: previousStage }, limit, env);
      return;
    }

    if (!result.ok) {
      fail(id, state, upcoming, `the ${upcoming} agent exited ${result.exitCode} — see \`sfo logs ${id}\``, env);
      return;
    }

    // A research stage that concludes "this already exists" must be able to
    // stop the pipeline. Otherwise a 30KB prior-art document changes nothing
    // and the project spends the spec stage — and later the whole build —
    // rebuilding something the user could install today.
    if (upcoming === "research") {
      const priorArt = readPriorArt(id, env);
      if (priorArt && blocksPipeline(priorArt.verdict)) {
        state = {
          ...state,
          status: "awaiting_human",
          pid: null,
          completedStage: upcoming,
          updatedAt: new Date().toISOString(),
        };
        writeState(state, env);
        commitStage(id, upcoming, env);
        return;
      }
    }

    if (upcoming === "test-repair") {
      const unsealed = sealSuite(id, env, opts);
      if (unsealed) {
        fail(id, state, upcoming, unsealed, env);
        return;
      }
    }

    // Drafts are how a person judges a look before anything is built; they
    // are drawn now so clarify can show them.
    if (upcoming === "spec") {
      try {
        (opts.drawDrafts ?? drawDrafts)(id, env ?? process.env);
      } catch (err) {
        console.error(`sfo: could not draw the drafts — ${reason(err)}`);
      }
    }

    // Only on success. A failed stage's partial output stays uncommitted so the
    // retry diffs against the last state that was actually good.
    commitStage(id, upcoming, env);
    state = markCompleted(id, upcoming, env);
    if (upcoming === "deliver") clearRetry(id, env);
  }
}

/** Records that `stage` finished, re-reading first because the heartbeat writes too. */
function markCompleted(id: string, stage: string, env: Env | undefined): ProjectState {
  const state = { ...readState(id, env), completedStage: stage, updatedAt: new Date().toISOString() };
  writeState(state, env);
  return state;
}
