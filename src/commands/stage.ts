import { ClaudeCodeRunner } from "../runner/claude-code.js";
import { loadPrompt } from "../stages/prompts.js";
import { projectDir, logPath, type Env } from "../core/paths.js";
import { readState, writeState } from "../core/state.js";
import { recordCost } from "../core/cost.js";
import { commitStage } from "../core/repo.js";
import type { Runner } from "../runner/types.js";

/**
 * Re-runs one stage in isolation against the artifacts already on disk.
 * This is the payoff of artifacts-as-state: when a spec comes back wrong you
 * re-run `spec` alone and diff, instead of replaying the whole pipeline.
 *
 * The runner is injectable purely so this is testable without spending tokens.
 */
export async function runSingleStage(
  id: string,
  stage: string,
  env?: Env,
  runner: Runner = new ClaudeCodeRunner(),
): Promise<void> {
  const state = readState(id, env);

  const result = await runner.runStage({
    workdir: projectDir(id, env),
    prompt: loadPrompt(stage),
    logPath: logPath(id, stage, env),
  });

  // Re-runs are appended, not replaced — the bill counts every attempt.
  recordCost(id, stage, result.ok, result.usage, env);

  if (result.ok && state.status === "failed") {
    // `advance` refuses failed projects and its error tells the user to come
    // here. Without clearing the status, they re-run the stage successfully
    // and `sfo run` still refuses — the recovery path dead-ends on itself.
    writeState(
      {
        ...state,
        currentStage: stage,
        status: "awaiting_human",
        pid: null,
        updatedAt: new Date().toISOString(),
      },
      env,
    );
    commitStage(id, stage, env);
    console.log(`${stage} ok — ${id} is no longer failed, run \`sfo run ${id}\` to continue`);
    return;
  }

  // The whole point of `sfo stage`: without a commit, a re-run silently
  // overwrites the artifacts it was supposed to be compared against.
  if (result.ok) commitStage(id, stage, env);

  console.log(result.ok ? `${stage} ok` : `${stage} failed (exit ${result.exitCode})`);
}
