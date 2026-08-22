import { readState, writeState } from "./state.js";
import { nextStage, blocksOnHuman } from "./stages.js";
import { artifactExists } from "./artifacts.js";
import { readCriteria } from "./criteria.js";
import { recordCost } from "./cost.js";
import { budgetState, formatBudget, type BudgetState } from "./budget.js";
import { readDecisions, appendDecision } from "./decisions.js";
import { commitStage } from "./repo.js";
import { readPriorArt, blocksPipeline } from "./priorart.js";
import { loadPrompt } from "../stages/prompts.js";
import { projectDir, logPath, type Env } from "./paths.js";
import type { Runner } from "../runner/types.js";

/** The artifact a human must produce before a blocking stage can run. */
const HUMAN_INPUT: Record<string, string> = { clarify: "ANSWERS.json" };

export const HEARTBEAT_INTERVAL_MS = 30_000;

export interface AdvanceOptions {
  /** Overridable so tests can exercise ticking without waiting 30s. */
  heartbeatMs?: number;
}

/**
 * Keeps `heartbeatAt` fresh for the duration of a stage. Stamping it once at
 * stage start is not enough: real stages run for minutes, `isStale` uses a
 * 120s window, and a healthy long run would therefore read as dead to
 * `sfo status` and to the already-running guard in `sfo run`.
 */
function startHeartbeat(id: string, env: Env | undefined, intervalMs: number): () => void {
  const timer = setInterval(() => {
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
 * Stop and wait for the human rather than running anything, and why.
 *
 * Both reasons halt the pipeline, but they ask different things of the user —
 * "answer my questions" versus "raise the ceiling or take what is built" — so
 * the reason has to survive as far as the caller, not collapse to one sentinel.
 */
type Park =
  | { park: "human" }
  /** `stage` is the one that was refused, not the one that last ran. */
  | { park: "budget"; stage: string; budget: BudgetState };

const HUMAN_PARK: Park = { park: "human" };

function isPark(pick: string | null | Park): pick is Park {
  return pick !== null && typeof pick === "object";
}

/** What to run next, or the reason nothing runs. */
function pickStage(
  id: string,
  state: { currentStage: string; status: string },
  env: Env | undefined,
): string | null | Park {
  const target = pickTarget(id, state, env);
  if (!isPark(target) && target !== null) {
    // Checked here, before dispatch, and never after recording what a stage
    // cost. Charging first and checking afterwards overshoots by exactly one
    // stage every time, and a stage costs the same order as a small ceiling.
    const budget = budgetState(id, env);
    if (budget?.exceeded) return { park: "budget", stage: target, budget };
  }
  return target;
}

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
  state: { currentStage: string; status: string },
  env: Env | undefined,
): string | null | Park {
  const current = state.currentStage;

  if (
    blocksOnHuman(current) &&
    state.status === "awaiting_human" &&
    artifactExists(id, HUMAN_INPUT[current], env)
  ) {
    return current;
  }

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

export async function advance(
  id: string,
  runner: Runner,
  env?: Env,
  opts: AdvanceOptions = {},
): Promise<void> {
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_INTERVAL_MS;
  let state = readState(id, env);
  if (state.status === "done") return;

  // Refusing to advance a failed project closes two data-loss paths. Advancing
  // past a failed stage would silently skip the work it never finished, and a
  // failed `clarify` would fall straight through `nextStage() === null` and be
  // marked `done` — reporting success for a spec that never absorbed the
  // human's answers. `currentStage` alone cannot distinguish "resume this" from
  // "advance past this", so the status has to be the gate.
  if (state.status === "failed") {
    throw new Error(
      `${id} failed at stage "${state.currentStage}" — re-run it with \`sfo stage ${id} ${state.currentStage}\` before advancing`,
    );
  }

  while (true) {
    const upcoming = pickStage(id, state, env);

    if (upcoming === null) {
      state = { ...state, status: "done", pid: null, updatedAt: new Date().toISOString() };
      writeState(state, env);
      return;
    }

    if (isPark(upcoming)) {
      // A human park moves onto the stage that is waiting for the human. A
      // budget park stays where it is: the picked stage never ran, and marking
      // it current would make the next `pickStage` ask for the one after it —
      // silently skipping the work the ceiling only postponed.
      const target =
        upcoming.park === "budget"
          ? state.currentStage
          : (nextStage(state.currentStage) ?? state.currentStage);
      state = {
        ...state,
        currentStage: target,
        status: "awaiting_human",
        pid: null,
        updatedAt: new Date().toISOString(),
      };
      writeState(state, env);
      if (upcoming.park === "budget") recordBudgetPark(id, upcoming.stage, upcoming.budget, env);
      return;
    }

    state = {
      ...state,
      currentStage: upcoming,
      status: "running",
      pid: process.pid,
      heartbeatAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    writeState(state, env);

    const criteriaBefore = criterionIds(id, env);
    const stopHeartbeat = startHeartbeat(id, env, heartbeatMs);
    let result;
    try {
      result = await runner.runStage({
        workdir: projectDir(id, env),
        prompt: loadPrompt(upcoming),
        logPath: logPath(id, upcoming, env),
      });
    } finally {
      stopHeartbeat();
    }

    // Recorded before the ok/failed branch: a stage that failed still spent
    // money, and billing only the happy path under-reports every retry.
    recordCost(id, upcoming, result.ok, result.usage, env);

    warnOnDroppedCriteria(criteriaBefore, criterionIds(id, env), upcoming);

    // The heartbeat rewrote state under us, so re-read before mutating rather
    // than writing back a stale in-memory copy.
    state = readState(id, env);

    if (!result.ok) {
      state = {
        ...state,
        status: "failed",
        pid: null,
        attempts: { ...state.attempts, [upcoming]: (state.attempts[upcoming] ?? 0) + 1 },
        updatedAt: new Date().toISOString(),
      };
      writeState(state, env);
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
          updatedAt: new Date().toISOString(),
        };
        writeState(state, env);
        commitStage(id, upcoming, env);
        return;
      }
    }

    // Only on success. A failed stage's partial output stays uncommitted so the
    // retry diffs against the last state that was actually good.
    commitStage(id, upcoming, env);
  }
}
