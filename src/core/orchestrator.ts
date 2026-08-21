import { readState, writeState } from "./state.js";
import { nextStage, blocksOnHuman } from "./stages.js";
import { artifactExists } from "./artifacts.js";
import { loadPrompt } from "../stages/prompts.js";
import { projectDir, logPath, type Env } from "./paths.js";
import type { Runner } from "../runner/types.js";

/** The artifact a human must produce before a blocking stage can run. */
const HUMAN_INPUT: Record<string, string> = { clarify: "ANSWERS.md" };

export async function advance(id: string, runner: Runner, env?: Env): Promise<void> {
  let state = readState(id, env);
  if (state.status === "done") return;

  while (true) {
    const upcoming = nextStage(state.currentStage);
    if (upcoming === null) {
      state = { ...state, status: "done", pid: null, updatedAt: new Date().toISOString() };
      writeState(state, env);
      return;
    }

    // A human stage waits for the human's artifact, then runs like any other.
    // Without the artifactExists check the stage would be skipped entirely:
    // we'd park at `clarify`, and the next `advance` would see nextStage() ===
    // null and mark the project done without ever folding answers into the spec.
    if (blocksOnHuman(upcoming) && !artifactExists(id, HUMAN_INPUT[upcoming], env)) {
      state = {
        ...state,
        currentStage: upcoming,
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

    const result = await runner.runStage({
      workdir: projectDir(id, env),
      prompt: loadPrompt(upcoming),
      logPath: logPath(id, upcoming, env),
    });

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
  }
}
