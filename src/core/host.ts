import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ProjectState } from "./state.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** What a host is asked to run for a project, unattended. */
export type HostCommand =
  | { kind: "run"; anyway?: boolean; useApiKey?: boolean }
  | { kind: "feedback"; entry: number };

/**
 * Where a project's unattended work executes: a detached process on this
 * machine, or (next) a Fly Machine per run. The pipeline itself is the same
 * everywhere; a host only starts it and ends it.
 */
export interface RunHost {
  /** Starts `command` for `id` without waiting, and says where it went. */
  start(id: string, command: HostCommand): string;
  /** Ends whatever is running for `id`. False when it was already gone. */
  stop(state: ProjectState): boolean;
}

/**
 * The CLI invocation that does the work in the foreground. Any override the
 * person gave travels with it: the work re-enters the CLI and re-runs its
 * guards, and a refusal there would be invisible.
 */
export function commandArgs(id: string, command: HostCommand): string[] {
  switch (command.kind) {
    case "run":
      return ["run", id, "--attach", ...(command.anyway ? ["--anyway"] : []), ...(command.useApiKey ? ["--use-api-key"] : [])];
    case "feedback":
      return ["feedback", id, "--entry", String(command.entry), "--attach"];
  }
}

type Kill = (pid: number, signal: NodeJS.Signals) => void;

export function localHost(kill: Kill = (pid, sig) => process.kill(pid, sig)): RunHost {
  return {
    start(id, command) {
      const child = spawn(process.execPath, [path.join(here, "..", "cli.js"), ...commandArgs(id, command)], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      return `pid ${child.pid ?? -1}`;
    },
    // The detached run leads its own process group, so the group is signalled:
    // the stage's `claude` process and any test it was running go with it,
    // instead of carrying on spending with nobody to record the result.
    stop(state) {
      if (state.pid === null) return false;
      for (const target of [-state.pid, state.pid]) {
        try {
          kill(target, "SIGTERM");
          return true;
        } catch {
          // Not a group leader (an attached run), or already gone.
        }
      }
      return false;
    },
  };
}
