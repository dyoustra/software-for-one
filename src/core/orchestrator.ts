import { readState, writeState } from "./state.js";
import { nextStage, blocksOnHuman } from "./stages.js";
import { artifactExists } from "./artifacts.js";
import { readCriteria } from "./criteria.js";
import { recordCost } from "./cost.js";
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

/** Sentinel: stop and wait for the human rather than running anything. */
const PARK = Symbol("park");

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
function pickStage(
  id: string,
  state: { currentStage: string; status: string },
  env: Env | undefined,
): string | null | typeof PARK {
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
    return PARK;
  }
  return upcoming;
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

    if (upcoming === PARK) {
      const target = nextStage(state.currentStage) ?? state.currentStage;
      state = {
        ...state,
        currentStage: target,
        status: "awaiting_human",
        pid: null,
        updatedAt: new Date().toISOString(),
      };
      writeState(state, env);
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
