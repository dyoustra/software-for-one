import { ClaudeCodeRunner } from "../runner/claude-code.js";
import { loadPrompt } from "../stages/prompts.js";
import { projectDir, logPath, type Env } from "../core/paths.js";
import { readState, writeState } from "../core/state.js";
import { budgetState, formatBudget } from "../core/budget.js";
import { recordCost } from "../core/cost.js";
import { commitStage } from "../core/repo.js";
import { sealSuite } from "../core/orchestrator.js";
import { writeFailure } from "../core/stopped.js";
import { agentToolsForStage } from "../core/verify.js";
import type { Runner } from "../runner/types.js";
import { resolveProjectAccess } from "../core/access.js";

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
  injected?: Runner,
  seal: typeof sealSuite = sealSuite,
): Promise<void> {
  const state = readState(id, env);

  // The build prompt reads "you are building one slice, named in your
  // instructions" — and this command has no slice to name. Running it anyway
  // spends a full stage on an agent told to build something unspecified.
  if (stage === "smoke") {
    throw new Error(
      `smoke runs real checks and a repair loop, not one agent — it runs as part of \`sfo run ${id}\``,
    );
  }
  if (stage === "build") {
    throw new Error(
      `the build stage runs one slice at a time and \`sfo stage\` has no slice to give it — ` +
        `use \`sfo retry ${id}\` to clear a failed slice, then \`sfo run ${id}\``,
    );
  }

  // `sfo stage` is the manual escape hatch, so the ceiling warns rather than
  // refuses — invoking it by hand IS the human decision the ceiling routes to.
  // But spending past a ceiling in silence is the failure this whole product
  // exists to prevent, so it is said out loud before the money goes.
  const budget = budgetState(id, env);
  if (budget?.exceeded) {
    console.log(
      `warning: ${id} is over its ceiling — ${formatBudget(budget)}.\n` +
        `running ${stage} anyway will spend past it. Raise it with \`sfo budget ${id} <usd>\`.`,
    );
  }

  // Resolved after the id is known to exist, so a typo reports "no such
  // project" rather than a missing key.
  const runner = injected ?? new ClaudeCodeRunner({ access: resolveProjectAccess(id, { env }) });
  const result = await runner.runStage({
    workdir: projectDir(id, env),
    prompt: loadPrompt(stage),
    logPath: logPath(id, stage, env),
    allowedTools: agentToolsForStage(id, stage, env),
  });

  // Re-runs are appended, not replaced — the bill counts every attempt.
  recordCost(id, stage, result.ok, result.usage, env, "cli", result.billing);

  // The checks and the lock that follow test-repair in a run follow it here
  // too: skipped, the build is graded against an unlocked suite and every
  // slice is refused.
  const unsealed = result.ok && stage === "test-repair" ? seal(id, env) : null;
  if (unsealed) {
    commitStage(id, stage, env);
    writeFailure(id, { stage, reason: unsealed, at: new Date().toISOString() }, env);
    writeState({ ...state, currentStage: stage, status: "failed", pid: null, updatedAt: new Date().toISOString() }, env);
    console.log(`${stage} ran, but ${unsealed}`);
    return;
  }

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
