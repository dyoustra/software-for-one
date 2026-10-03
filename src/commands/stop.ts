import { readState, writeState } from "../core/state.js";
import { writeStopped } from "../core/stopped.js";
import { localHost, type RunHost } from "../core/host.js";
import type { Env } from "../core/paths.js";

/** Stops a running project, leaving every artifact as it was. */
export function stopRun(id: string, env?: Env, host: RunHost = localHost()): string {
  const state = readState(id, env);
  if (state.status !== "running" || state.pid === null) {
    throw new Error(`${id} is not running (${state.status})`);
  }

  const signalled = host.stop(state);
  writeState({ ...state, status: "awaiting_human", pid: null, updatedAt: new Date().toISOString() }, env);
  writeStopped(id, state.currentStage, env);
  return signalled
    ? `stopped ${id} during ${state.currentStage} — \`sfo run ${id}\` resumes it`
    : `${id}'s process was already gone; marked stopped at ${state.currentStage} — \`sfo run ${id}\` resumes it`;
}
