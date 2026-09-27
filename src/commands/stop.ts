import { readState, writeState } from "../core/state.js";
import { writeStopped } from "../core/stopped.js";
import type { Env } from "../core/paths.js";

type Kill = (pid: number, signal: NodeJS.Signals) => void;

/**
 * Stops a running project, leaving every artifact as it was. The detached run
 * leads its own process group, so the group is signalled: the stage's `claude`
 * process and any test it was running go with it, instead of carrying on
 * spending with nobody to record the result.
 */
export function stopRun(id: string, env?: Env, kill: Kill = (pid, sig) => process.kill(pid, sig)): string {
  const state = readState(id, env);
  if (state.status !== "running" || state.pid === null) {
    throw new Error(`${id} is not running (${state.status})`);
  }

  let signalled = false;
  for (const target of [-state.pid, state.pid]) {
    try {
      kill(target, "SIGTERM");
      signalled = true;
      break;
    } catch {
      // Not a group leader (an attached run), or already gone.
    }
  }

  writeState({ ...state, status: "awaiting_human", pid: null, updatedAt: new Date().toISOString() }, env);
  writeStopped(id, state.currentStage, env);
  return signalled
    ? `stopped ${id} during ${state.currentStage} — \`sfo run ${id}\` resumes it`
    : `${id}'s process was already gone; marked stopped at ${state.currentStage} — \`sfo run ${id}\` resumes it`;
}
