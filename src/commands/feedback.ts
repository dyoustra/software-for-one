import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readState, writeState, isStale } from "../core/state.js";
import { addFeedback, runFeedback, type FeedbackOutcome } from "../core/feedback.js";
import { startHeartbeat, HEARTBEAT_INTERVAL_MS } from "../core/orchestrator.js";
import { detectArchetype, runVerify, checkSuiteBeforeLock, runPassedGate } from "../core/verify.js";
import { resolveProjectAccess } from "../core/access.js";
import { installTool } from "../core/install.js";
import { captureRenders } from "../core/presentation.js";
import { desktopNotifier, type Notifier } from "../core/notify.js";
import { runnerFor } from "./run.js";
import type { Runner } from "../runner/types.js";
import type { Env } from "../core/paths.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Feedback changes a finished project; a project mid-run has not finished. */
function guardIdle(id: string, env?: Env): void {
  const state = readState(id, env);
  if (state.status === "running" && !isStale(state)) {
    throw new Error(`${id} is running (pid ${state.pid}) — give feedback once it has finished`);
  }
}

export function recordFeedback(id: string, text: string, env?: Env): number {
  guardIdle(id, env);
  return addFeedback(id, text, env).n;
}

export function startFeedbackDetached(id: string, n: number): number {
  const child = spawn(process.execPath, [path.join(here, "..", "cli.js"), "feedback", id, "--entry", String(n), "--attach"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child.pid ?? -1;
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

/**
 * Applies feedback entry `n` in this process. The project reads as running
 * while it does, so `sfo run` and a second `sfo feedback` wait their turn,
 * and returns to the status it had afterwards.
 */
export async function runFeedbackAttached(
  id: string,
  n: number,
  env?: Env,
  deps: { runner?: Runner; notify?: Notifier; heartbeatMs?: number } = {},
): Promise<FeedbackOutcome> {
  guardIdle(id, env);
  const before = readState(id, env);
  writeState({ ...before, status: "running", pid: process.pid, heartbeatAt: new Date().toISOString() }, env);
  const archetype = detectArchetype(id, env);
  const runner = deps.runner ?? runnerFor(id, resolveProjectAccess(id, { env }), env);
  let outcome: FeedbackOutcome;
  try {
    outcome = await runFeedback(
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
          installTool(id, archetype, env ?? process.env);
          captureRenders(id, archetype, env ?? process.env);
        },
      },
      n,
    );
  } finally {
    writeState({ ...readState(id, env), status: before.status, pid: null, updatedAt: new Date().toISOString() }, env);
  }
  (deps.notify ?? desktopNotifier)(`sfo: ${before.title}`, describe(outcome));
  return outcome;
}
