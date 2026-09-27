import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { retrySlices } from "../../src/commands/retry.js";
import { readState, writeState } from "../../src/core/state.js";
import { writeSlices } from "../../src/core/slices.js";
import type { Slice } from "../../src/core/slices.js";

let env: Record<string, string>;

const SLICES: Slice[] = [
  { id: "S-01", name: "Enumeration", criterionIds: ["AC-001"], prerequisites: [] },
  { id: "S-02", name: "Naming", criterionIds: ["AC-002"], prerequisites: ["S-01"] },
  { id: "S-03", name: "Reporting", criterionIds: ["AC-003"], prerequisites: [] },
];

function seed(
  slicesFailed: string[],
  sliceAttempts: Record<string, number>,
  where: { currentStage: string; status: "failed" | "done" } = {
    currentStage: "build",
    status: "failed",
  },
) {
  fs.mkdirSync(path.join(env.SFO_HOME, "p", ".sfo"), { recursive: true });
  writeState(
    {
      id: "p",
      title: "T",
      currentStage: where.currentStage,
      status: where.status,
      attempts: { build: 1 },
      sliceAttempts,
      slicesPassed: [],
      slicesFailed,
      pid: null,
      heartbeatAt: null,
      createdAt: "2026-08-22T00:00:00.000Z",
      updatedAt: "2026-08-22T00:00:00.000Z",
    },
    env,
  );
  writeSlices("p", SLICES, env);
}

beforeEach(() => {
  env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-retry-")) };
});

describe("retrySlices", () => {
  it("clears every failed slice and its attempt count", () => {
    seed(["S-01", "S-03"], { "S-01": 2, "S-03": 2 });

    const out = retrySlices("p", undefined, env);

    const s = readState("p", env);
    expect(s.slicesFailed).toEqual([]);
    expect(s.sliceAttempts).toEqual({});
    expect(out).toMatch(/S-01, S-03 will be attempted again/);
  });

  it("clears one named slice and leaves the others failed", () => {
    seed(["S-01", "S-03"], { "S-01": 2, "S-03": 2 });

    retrySlices("p", "S-01", env);

    const s = readState("p", env);
    expect(s.slicesFailed).toEqual(["S-03"]);
    expect(s.sliceAttempts).toEqual({ "S-03": 2 });
  });

  it("makes a failed project runnable again", () => {
    // Without this `sfo run` refuses the project and points back at retry,
    // which is a loop with no way out.
    seed(["S-01"], { "S-01": 2 });

    retrySlices("p", undefined, env);

    expect(readState("p", env).status).toBe("awaiting_human");
  });

  it("reopens the build of a project that already delivered", () => {
    // A build with a failed slice still runs review and deliver and ends done.
    // Left at deliver/done, `sfo run` would do nothing after the retry.
    seed(["S-01"], { "S-01": 2 }, { currentStage: "deliver", status: "done" });

    retrySlices("p", undefined, env);

    const s = readState("p", env);
    expect(s.currentStage).toBe("build");
    expect(s.status).toBe("awaiting_human");
  });

  it("names the dependents that come back into play", () => {
    // S-02 was skipped rather than attempted, so it carries no failure of its
    // own — but clearing S-01 is the difference between one slice's cost and
    // three, and the user should know that before running.
    seed(["S-01"], { "S-01": 2 });

    expect(retrySlices("p", undefined, env)).toMatch(/unblocking S-02/);
  });

  it("says so plainly when nothing failed", () => {
    seed([], {});
    expect(retrySlices("p", undefined, env)).toMatch(/no failed slices/);
  });

  it("rejects a slice that did not fail rather than silently doing nothing", () => {
    seed(["S-01"], { "S-01": 2 });
    expect(() => retrySlices("p", "S-99", env)).toThrow(/S-99 did not fail/);
  });

  it("leaves the stage retry counter alone", () => {
    // attempts and sliceAttempts are separate counters; clearing a slice must
    // not hand the build stage itself a fresh budget of retries.
    seed(["S-01"], { "S-01": 2 });
    retrySlices("p", undefined, env);
    expect(readState("p", env).attempts).toEqual({ build: 1 });
  });
});
