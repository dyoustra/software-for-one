import { readState, writeState } from "../core/state.js";
import { readSmokeRecords, latestSmoke } from "../core/smoke.js";
import { readFindings } from "../core/findings.js";
import { writeRetry } from "../core/retry.js";
import { readSlices, skippedBy } from "../core/slices.js";
import type { Env } from "../core/paths.js";

/** Stages that report on the build. A retry reopens the build, so they rerun. */
const PAST_BUILD = new Set(["smoke", "review", "deliver"]);

/**
 * Clears a slice's failure so the build loop attempts it again.
 *
 * `sfo stage <id> build` cannot serve as the recovery path: the build prompt
 * expects a slice named in its instructions and that command has none to give.
 * The real remedy after a failed slice is not re-running a stage anyway — it is
 * discarding the verdict, because the loop already resumes at the first slice
 * that has neither passed nor failed.
 */
export function retrySlices(id: string, sliceId?: string, env?: Env): string {
  const state = readState(id, env);

  if (state.slicesFailed.length === 0) {
    return `${id} has no failed slices`;
  }

  const targets = sliceId ? [sliceId] : [...state.slicesFailed];
  const unknown = targets.filter((s) => !state.slicesFailed.includes(s));
  if (unknown.length > 0) {
    throw new Error(
      `${unknown.join(", ")} did not fail — failed slices are ${state.slicesFailed.join(", ")}`,
    );
  }

  const slicesFailed = state.slicesFailed.filter((s) => !targets.includes(s));
  const sliceAttempts = { ...state.sliceAttempts };
  for (const s of targets) delete sliceAttempts[s];

  writeState(
    {
      ...state,
      slicesFailed,
      sliceAttempts,
      // A project that already delivered is past `build`, and `done` at the
      // last stage makes `advance` return without running anything. The build
      // is reopened, and review and deliver run again on the new result
      // rather than leaving a summary that describes the failure.
      currentStage: PAST_BUILD.has(state.currentStage) ? "build" : state.currentStage,
      // A project that gave up is runnable again; without this `sfo run`
      // refuses and points back here, which is a loop with no exit.
      status: state.status === "failed" || state.status === "done" ? "awaiting_human" : state.status,
      pid: null,
      updatedAt: new Date().toISOString(),
    },
    env,
  );

  // Dependents were skipped rather than attempted, so they carry no failure of
  // their own to clear — but the user should be told they are back in play,
  // since that is the difference between one slice's cost and many.
  const revived = skippedBy(readSlices(id, env), targets).filter(
    (s) => !state.slicesPassed.includes(s),
  );
  const also = revived.length > 0 ? `, unblocking ${revived.join(", ")}` : "";

  return `${targets.join(", ")} will be attempted again${also} — run \`sfo run ${id}\``;
}

/**
 * `sfo retry <id>`: redo everything that failed and nothing that passed —
 * failed slices, seams whose latest check failed, and high findings still
 * unrepaired that have a test to repair against. The run restarts at the
 * earliest stage with work to do.
 */
export interface Failures {
  slices: string[];
  seams: string[];
  /** High findings still unrepaired that have a test to repair against. */
  findings: string[];
  /** High findings with no test: only a person's feedback can act on these. */
  notRetryable: string[];
}

/** What failed, sorted by whether a retry can act on it. */
export function failures(id: string, env?: Env): Failures {
  const state = readState(id, env);
  let seams: string[] = [];
  let findings: string[] = [];
  let notRetryable: string[] = [];
  try {
    seams = [...new Set(latestSmoke(readSmokeRecords(id, env)).filter((r) => r.level === "failed").map((r) => r.seam))];
  } catch {
    // No readable smoke record: nothing of that kind to retry.
  }
  try {
    const high = readFindings(id, env).filter((f) => f.severity === "high");
    findings = high.filter((f) => f.status === "unrepaired" && f.test).map((f) => f.id);
    notRetryable = high
      .filter((f) => (f.status === "unrepaired" && !f.test) || (f.round === 2 && f.status === "report_only"))
      .map((f) => f.id);
  } catch {
    // Likewise.
  }
  return { slices: [...state.slicesFailed], seams, findings, notRetryable };
}

export function retryFailed(id: string, env?: Env): string {
  const state = readState(id, env);
  const { slices, seams, findings, notRetryable } = failures(id, env);
  if (slices.length + seams.length + findings.length === 0) {
    return notRetryable.length > 0
      ? `nothing ${id} can retry: ${notRetryable.join(", ")} have no test to repair against`
      : `${id} has nothing that failed`;
  }

  const parts: string[] = [];
  if (slices.length > 0) {
    parts.push(retrySlices(id, undefined, env).split(" — ")[0]);
  } else {
    // Rewind to just before the earliest stage with work. A stage marked
    // complete there makes the next run pick the one after it.
    const before = seams.length > 0 ? "build" : "smoke";
    writeState(
      {
        ...state,
        currentStage: before,
        completedStage: before,
        status: "awaiting_human",
        pid: null,
        updatedAt: new Date().toISOString(),
      },
      env,
    );
  }
  if (seams.length > 0) parts.push(`seam${seams.length === 1 ? "" : "s"} ${seams.join(", ")} will be checked again`);
  if (findings.length > 0) parts.push(`${findings.join(", ")} will get another repair round`);
  writeRetry(id, { slices, seams, findings, at: new Date().toISOString() }, env);

  const skipped = notRetryable.length > 0 ? ` (${notRetryable.join(", ")} have no test to repair against, and stay reported)` : "";
  return `${parts.join("; ")}${skipped} — run \`sfo run ${id}\``;
}

