import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordFeedback, runFeedbackAttached } from "../../src/commands/feedback.js";
import { addFeedback, readFeedback, updateFeedback, type FeedbackOutcome } from "../../src/core/feedback.js";
import { writeState, readState, type ProjectState } from "../../src/core/state.js";

let env: Record<string, string>;

function seed(status: ProjectState["status"], heartbeatAt: string | null = null) {
  fs.mkdirSync(path.join(env.SFO_HOME, "p", ".sfo"), { recursive: true });
  writeState(
    {
      id: "p",
      title: "T",
      currentStage: "deliver",
      status,
      attempts: {},
      pid: status === "running" ? 4242 : null,
      heartbeatAt,
      createdAt: "2026-10-03T00:00:00.000Z",
      updatedAt: "2026-10-03T00:00:00.000Z",
    },
    env,
  );
}

/** Applies an entry the way the agent would, recording each one it is given. */
function applier(applied: number[], during?: (n: number) => void) {
  return async (n: number): Promise<FeedbackOutcome> => {
    applied.push(n);
    during?.(n);
    updateFeedback("p", n, { status: "done", summary: `did ${n}` }, env);
    return { outcome: "done", summary: `did ${n}` };
  };
}

const quiet = { notify: () => {} };

beforeEach(() => {
  env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-feedback-")) };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("several pieces of feedback", () => {
  it("applies every entry queued behind the first, in order, and goes back to done", async () => {
    seed("done");
    for (const text of ["one", "two", "three"]) addFeedback("p", text, env);
    const applied: number[] = [];

    const outcomes = await runFeedbackAttached("p", 1, env, { ...quiet, apply: applier(applied) });

    expect(applied).toEqual([1, 2, 3]);
    expect(outcomes.map((o) => o.outcome)).toEqual(["done", "done", "done"]);
    expect(readState("p", env)).toMatchObject({ status: "done", pid: null });
  });

  it("picks up feedback given while it is applying", async () => {
    seed("done");
    addFeedback("p", "one", env);
    const applied: number[] = [];
    const later = (n: number) => {
      if (n === 1) expect(recordFeedback("p", "two", env)).toEqual({ n: 2, queued: true });
    };

    await runFeedbackAttached("p", 1, env, { ...quiet, apply: applier(applied, later) });

    expect(applied).toEqual([1, 2]);
  });

  it("stops at a plan limit and leaves the rest pending", async () => {
    seed("done");
    for (const text of ["one", "two"]) addFeedback("p", text, env);
    const limited = async (): Promise<FeedbackOutcome> => ({ outcome: "limit", limit: { resetsAt: null } as never });

    const outcomes = await runFeedbackAttached("p", 1, env, { ...quiet, apply: limited });

    expect(outcomes).toHaveLength(1);
    expect(readFeedback("p", env).map((e) => e.status)).toEqual(["pending", "pending"]);
    expect(readState("p", env).status).toBe("done");
  });

  it("starts a worker for feedback given when nothing is running", () => {
    seed("done");
    expect(recordFeedback("p", "one", env)).toEqual({ n: 1, queued: false });
  });

  it("still refuses feedback while a build, not feedback, is running", () => {
    seed("running", new Date().toISOString());
    expect(() => recordFeedback("p", "one", env)).toThrow(/is running .* once it has finished/);
    expect(readFeedback("p", env)).toEqual([]);
  });
});
