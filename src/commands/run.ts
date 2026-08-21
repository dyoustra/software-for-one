import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { advance } from "../core/orchestrator.js";
import { ClaudeCodeRunner } from "../runner/claude-code.js";
import { readState, isStale } from "../core/state.js";

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

export function guardAlreadyRunning(id: string): void {
  const state = readState(id);
  if (state.status === "running" && !isStale(state)) {
    throw new Error(`${id} is already running (pid ${state.pid}) — use \`sfo stop ${id}\` first`);
  }
}
