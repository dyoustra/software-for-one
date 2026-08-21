import { ClaudeCodeRunner } from "../runner/claude-code.js";
import { loadPrompt } from "../stages/prompts.js";
import { projectDir, logPath, type Env } from "../core/paths.js";

/**
 * Re-runs one stage in isolation against the artifacts already on disk.
 * This is the payoff of artifacts-as-state: when a spec comes back wrong you
 * re-run `spec` alone and diff, instead of replaying the whole pipeline.
 */
export async function runSingleStage(id: string, stage: string, env?: Env): Promise<void> {
  const runner = new ClaudeCodeRunner();
  const result = await runner.runStage({
    workdir: projectDir(id, env),
    prompt: loadPrompt(stage),
    logPath: logPath(id, stage, env),
  });
  console.log(result.ok ? `${stage} ok` : `${stage} failed (exit ${result.exitCode})`);
}
