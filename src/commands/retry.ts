import { readState, writeState } from "../core/state.js";
import { readSlices, skippedBy } from "../core/slices.js";
import type { Env } from "../core/paths.js";

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
      // A project that gave up is runnable again; without this `sfo run`
      // refuses and points back here, which is a loop with no exit.
      status: state.status === "failed" ? "awaiting_human" : state.status,
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
