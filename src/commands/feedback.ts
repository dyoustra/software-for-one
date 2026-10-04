import { readState, writeState, isStale } from "../core/state.js";
import { addFeedback, readFeedback, runFeedback, type FeedbackOutcome } from "../core/feedback.js";
import { startHeartbeat, HEARTBEAT_INTERVAL_MS } from "../core/orchestrator.js";
import { detectArchetype, runVerify, checkSuiteBeforeLock, runPassedGate } from "../core/verify.js";
import { resolveProjectAccess } from "../core/access.js";
import { reinstall } from "../core/install.js";
import { captureRenders } from "../core/presentation.js";
import { desktopNotifier, type Notifier } from "../core/notify.js";
import { runnerFor } from "./run.js";
import type { Runner } from "../runner/types.js";
import type { Env } from "../core/paths.js";

/** Feedback changes a finished project; a project mid-run has not finished. */
function guardIdle(id: string, env?: Env): void {
  const state = readState(id, env);
  if (state.status === "running" && !isStale(state)) {
    throw new Error(`${id} is running (pid ${state.pid}) — give feedback once it has finished`);
  }
}

function nextPending(id: string, env?: Env): number | null {
  return readFeedback(id, env).find((e) => e.status === "pending")?.n ?? null;
}

/**
 * Records feedback. While earlier feedback is being applied it queues behind
 * it, and the worker already running applies it next; anything else running
 * (a build, a check) still has to finish first.
 */
export function recordFeedback(id: string, text: string, env?: Env): { n: number; queued: boolean } {
  const state = readState(id, env);
  const busy = state.status === "running" && !isStale(state);
  if (busy && nextPending(id, env) === null) {
    throw new Error(`${id} is running (pid ${state.pid}) — give feedback once it has finished`);
  }
  const { n } = addFeedback(id, text, env);
  // The worker may have finished between the check and the append; then
  // nothing would pick this entry up, so the caller starts one.
  const stillBusy = busy && readState(id, env).status === "running";
  return { n, queued: stillBusy };
}

function describe(outcome: FeedbackOutcome): string {
  switch (outcome.outcome) {
    case "done":
      return `feedback applied — ${outcome.summary}`;
    case "too_big":
      return `too big for a follow-up — ${outcome.summary}`;
    case "failed":
      return `feedback not applied — ${outcome.reason}`;
    case "limit":
      return "the plan limit stopped it — `sfo feedback` again once it resets";
  }
}

type Apply = (n: number) => Promise<FeedbackOutcome>;

/**
 * Applies feedback entry `n` in this process, then every entry queued behind
 * it, in order. The project reads as running throughout, so `sfo run` waits
 * its turn and further feedback queues; it returns to the status it had
 * afterwards. A plan limit stops the queue, leaving the rest pending.
 */
export async function runFeedbackAttached(
  id: string,
  n: number,
  env?: Env,
  deps: { runner?: Runner; notify?: Notifier; heartbeatMs?: number; apply?: Apply } = {},
): Promise<FeedbackOutcome[]> {
  guardIdle(id, env);
  const before = readState(id, env);
  writeState({ ...before, status: "running", pid: process.pid, heartbeatAt: new Date().toISOString() }, env);
  const apply = deps.apply ?? applyWith(id, env, deps);
  const notify = deps.notify ?? desktopNotifier;
  const outcomes: FeedbackOutcome[] = [];
  try {
    for (let next: number | null = n; next !== null; next = nextPending(id, env)) {
      const outcome = await apply(next);
      outcomes.push(outcome);
      notify(`sfo: ${before.title}`, `feedback ${next}: ${describe(outcome)}`);
      if (outcome.outcome === "limit") return outcomes;
    }
  } finally {
    writeState({ ...readState(id, env), status: before.status, pid: null, updatedAt: new Date().toISOString() }, env);
  }
  // Queued in the moment between the last check and going idle.
  const late = nextPending(id, env);
  return late === null ? outcomes : [...outcomes, ...(await runFeedbackAttached(id, late, env, deps))];
}

function applyWith(id: string, env: Env | undefined, deps: { runner?: Runner; heartbeatMs?: number }): Apply {
  const archetype = detectArchetype(id, env);
  const runner = deps.runner ?? runnerFor(id, resolveProjectAccess(id, { env }), env);
  return (n) =>
    runFeedback(
      {
        id,
        env,
        runner,
        archetype,
        verify: runVerify,
        suiteCheck: checkSuiteBeforeLock,
        passedGate: runPassedGate,
        withHeartbeat: async (fn) => {
          const stop = startHeartbeat(id, env, deps.heartbeatMs ?? HEARTBEAT_INTERVAL_MS);
          try {
            return await fn();
          } finally {
            stop();
          }
        },
        afterwards: () => {
          reinstall(id, archetype, env ?? process.env);
          captureRenders(id, archetype, env ?? process.env);
        },
      },
      n,
    );
}
