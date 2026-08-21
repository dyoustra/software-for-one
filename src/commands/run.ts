import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { advance } from "../core/orchestrator.js";
import { ClaudeCodeRunner } from "../runner/claude-code.js";
import { readState, isStale } from "../core/state.js";
import type { Env } from "../core/paths.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Runs the pipeline in this process. Called by the detached child. */
export async function runAttached(id: string): Promise<void> {
  await advance(id, new ClaudeCodeRunner());
}

/** Forks a detached child and returns immediately. */
export function runDetached(id: string): number {
  const child = spawn(process.execPath, [path.join(here, "..", "cli.js"), "run", id, "--attach"], {
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
export function guardRunnable(id: string, env?: Env): void {
  const state = readState(id, env);
  if (state.status === "running" && !isStale(state)) {
    throw new Error(`${id} is already running (pid ${state.pid}) — wait for it to finish`);
  }
  if (state.status === "failed") {
    throw new Error(
      `${id} failed at stage "${state.currentStage}" — re-run it with \`sfo stage ${id} ${state.currentStage}\` before advancing`,
    );
  }
}
