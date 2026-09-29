import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { advance } from "../core/orchestrator.js";
import { ClaudeCodeRunner } from "../runner/claude-code.js";
import { readState, writeState, isStale } from "../core/state.js";
import { blockingPriorArt, readPriorArt } from "../core/priorart.js";
import { budgetState, formatBudget } from "../core/budget.js";
import { recoveryHint } from "../core/stages.js";
import type { Env } from "../core/paths.js";
import { readProfile, resolveAccess, resolveProjectAccess, type ResolvedAccess } from "../core/access.js";
import { recordCost } from "../core/cost.js";
import { FallbackRunner } from "../runner/fallback.js";
import { desktopNotifier, type Notifier } from "../core/notify.js";
import { writeCrash } from "../core/stopped.js";
import { listProjects } from "./status.js";
import type { Runner } from "../runner/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export interface GuardOptions {
  /** Build despite a blocking prior-art verdict. Scoped to that check alone. */
  anyway?: boolean;
  /** Run on the API key this time, whatever the profile prefers. */
  useApiKey?: boolean;
}

/** Runs the pipeline in this process. Called by the detached child. */
export async function runAttached(id: string, opts: GuardOptions = {}): Promise<void> {
  try {
    const access = resolveProjectAccess(id, { useApiKey: opts.useApiKey });
    await advance(id, runnerFor(id, access));
  } catch (err) {
    recordCrash(id, err);
    desktopNotifier(`sfo: ${id}`, `crashed — ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
  notifyOutcome(id);
}

/**
 * Leaves the project resumable and says why it stopped. Left alone it stays
 * `running` with a dead pid, which reads only as "stale", and the error itself
 * went to a detached process's discarded output.
 */
export function recordCrash(id: string, err: unknown, env?: Env): void {
  try {
    const state = readState(id, env);
    const error = err instanceof Error ? (err.stack ?? err.message) : String(err);
    writeCrash(id, { stage: state.currentStage, error, at: new Date().toISOString() }, env);
    writeState({ ...state, status: "awaiting_human", pid: null, updatedAt: new Date().toISOString() }, env);
  } catch {
    // Reporting the crash must not replace it with a different one.
  }
}

/**
 * Says where the run ended up, in the words `sfo status` would use. This is
 * the half of fire-and-forget that tells you it is time to come back.
 */
export function notifyOutcome(id: string, env?: Env, notify: Notifier = desktopNotifier): void {
  let state;
  try {
    state = readState(id, env);
  } catch {
    return;
  }
  const summary = listProjects(env).find((p) => p.id === id);
  const note = summary?.note;
  const base =
    state.status === "done"
      ? (note ?? "done — SUMMARY.md is ready")
      : state.status === "failed"
        ? (note ?? `failed at ${state.currentStage} — ${recoveryHint(id, state.currentStage)}`)
        : state.status === "awaiting_human"
          ? (note ?? `needs you — \`sfo answer ${id}\``)
          : null;
  const message = base && summary?.next && !base.includes(summary.next) ? `${base} → ${summary.next}` : base;
  if (message) notify(`sfo: ${state.title}`, message);
}

/**
 * The plan runner, wrapped in the fallback when the person opted in. A key
 * that cannot be found only loses the fallback, not the run: the plan works,
 * and the limit park still says what to do.
 */
export function runnerFor(id: string, access: ResolvedAccess, env?: Env): Runner {
  const plan = new ClaudeCodeRunner({ access });
  const profile = readProfile(env);
  if (access.method !== "claude_subscription" || !profile?.fallbackToApiKey) return plan;

  let keyAccess: ResolvedAccess;
  try {
    keyAccess = resolveAccess(null, profile, { env, useApiKey: true });
  } catch (err) {
    console.error(`sfo: fallback to the API key is on, but ${err instanceof Error ? err.message : String(err)}`);
    return plan;
  }
  return new FallbackRunner(plan, new ClaudeCodeRunner({ access: keyAccess }), (input, result) =>
    recordCost(id, path.basename(input.logPath, ".log"), false, result.usage, env, "cli", result.billing),
  );
}

/**
 * The child re-enters the CLI and so re-runs `guardRunnable`. Any override the
 * human gave the parent has to travel with it, or the child refuses the run
 * with stdio: "ignore" and the failure is invisible.
 */
export function detachedArgs(id: string, opts: GuardOptions = {}): string[] {
  return [
    "run",
    id,
    "--attach",
    ...(opts.anyway ? ["--anyway"] : []),
    ...(opts.useApiKey ? ["--use-api-key"] : []),
  ];
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
      `${id} failed at stage "${state.currentStage}" — ${recoveryHint(id, state.currentStage)}`,
    );
  }

  // Deliberately above the `--anyway` escape hatch: that flag is scoped to the
  // prior-art verdict, and a spending ceiling the user set is not an opinion
  // the pipeline gets to override on their behalf.
  const budget = budgetState(id, env);
  if (budget?.exceeded) {
    throw new Error(
      `${id} is at its budget ceiling — ${formatBudget(budget)}. Raise it with \`sfo budget ${id} <usd>\`, or keep what is already built`,
    );
  }

  // Resolved here as well as in the child, for the reason this guard exists: a
  // missing key would otherwise kill the detached child after "started".
  resolveProjectAccess(id, { env, useApiKey: opts.useApiKey });

  if (opts.anyway) return;

  // The verdict is the whole payoff of the research stage: for a well-trodden
  // idea we install something instead of building it. Re-running would step
  // straight past it — the orchestrator's gate only fires on the run that
  // produced the verdict — so the refusal has to happen here, and it has to
  // carry the recommendation. An override the user cannot see is not a choice.
  // A gate fails closed. `blockingPriorArt` swallows a malformed file because
  // `sfo status` must list every project without dying on one bad artifact —
  // but here that would mean a garbled verdict silently stops gating, and the
  // most likely thing to garble is the file that said "do not build this".
  if (state.status === "awaiting_human" && state.currentStage === "research") {
    try {
      readPriorArt(id, env);
    } catch (error) {
      throw new Error(
        `${id} has an unreadable PRIOR_ART.json (${error instanceof Error ? error.message : String(error)}) — re-run with \`sfo stage ${id} research\`, or \`sfo run ${id} --anyway\` to proceed without the verdict`,
      );
    }
  }

  const art = blockingPriorArt(state, env);
  if (art) {
    const reason =
      art.verdict === "no_gap"
        ? `research found this already exists: ${art.recommendation ?? art.summary}`
        : `research found close prior art (\`sfo why ${id}\`)`;
    throw new Error(`${reason} — run \`sfo run ${id} --anyway\` to build it regardless`);
  }
}
