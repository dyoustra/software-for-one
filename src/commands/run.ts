import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { advance } from "../core/orchestrator.js";
import { ClaudeCodeRunner } from "../runner/claude-code.js";
import { readState, isStale } from "../core/state.js";
import { blockingPriorArt } from "../core/priorart.js";
import type { Env } from "../core/paths.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export interface GuardOptions {
  /** Build despite a blocking prior-art verdict. Scoped to that check alone. */
  anyway?: boolean;
}

/** Runs the pipeline in this process. Called by the detached child. */
export async function runAttached(id: string): Promise<void> {
  await advance(id, new ClaudeCodeRunner());
}

/**
 * The child re-enters the CLI and so re-runs `guardRunnable`. Any override the
 * human gave the parent has to travel with it, or the child refuses the run
 * with stdio: "ignore" and the failure is invisible.
 */
export function detachedArgs(id: string, opts: GuardOptions = {}): string[] {
  return ["run", id, "--attach", ...(opts.anyway ? ["--anyway"] : [])];
}

/** Forks a detached child and returns immediately. */
export function runDetached(id: string, opts: GuardOptions = {}): number {
  const child = spawn(process.execPath, [path.join(here, "..", "cli.js"), ...detachedArgs(id, opts)], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child.pid ?? -1;
}

/**
 * Checked BEFORE spawning, not inside the child. A detached child runs with
 * stdio: "ignore", so anything it throws is discarded — the parent would have
 * already printed "started (pid N)" and the user would see a success message
 * for a run that died on the orchestrator's failed-status guard microseconds
 * later. Refusing here is the difference between an honest error and a lie.
 */
export function guardRunnable(id: string, env?: Env, opts: GuardOptions = {}): void {
  const state = readState(id, env);
  if (state.status === "running" && !isStale(state)) {
    throw new Error(`${id} is already running (pid ${state.pid}) — wait for it to finish`);
  }
  if (state.status === "failed") {
    throw new Error(
      `${id} failed at stage "${state.currentStage}" — re-run it with \`sfo stage ${id} ${state.currentStage}\` before advancing`,
    );
  }

  if (opts.anyway) return;

  // The verdict is the whole payoff of the research stage: for a well-trodden
  // idea we install something instead of building it. Re-running would step
  // straight past it — the orchestrator's gate only fires on the run that
  // produced the verdict — so the refusal has to happen here, and it has to
  // carry the recommendation. An override the user cannot see is not a choice.
  const art = blockingPriorArt(state, env);
  if (art) {
    const reason =
      art.verdict === "no_gap"
        ? `research found this already exists: ${art.recommendation ?? art.summary}`
        : `research found close prior art (\`sfo why ${id}\`)`;
    throw new Error(`${reason} — run \`sfo run ${id} --anyway\` to build it regardless`);
  }
}
