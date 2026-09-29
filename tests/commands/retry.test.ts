import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { retrySlices, retryFailed } from "../../src/commands/retry.js";
import { readRetry } from "../../src/core/retry.js";
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

describe("retryFailed", () => {
  const sfo = (file: string, lines: object[]) =>
    fs.writeFileSync(path.join(env.SFO_HOME, "p", ".sfo", file), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const smoke = (seam: string, level: string, attempt = 1) => ({ seam, check: "c", level, detail: "", attempt, at: "2026-09-29T00:00:00.000Z" });
  const finding = (id: string, over: object) => ({ id, round: 1, severity: "high", kind: "code", summary: "s", evidence: "e", status: "unrepaired", ...over });

  it("says so when nothing failed", () => {
    seed([], {}, { currentStage: "deliver", status: "done" });
    expect(retryFailed("p", env)).toBe("p has nothing that failed");
  });

  it("retries only the seams whose latest check failed, rewinding to just after the build", () => {
    seed([], {}, { currentStage: "deliver", status: "done" });
    sfo("SMOKE.jsonl", [smoke("rss", "failed"), smoke("rss", "completed", 2), smoke("colour", "failed", 1), smoke("colour", "failed", 2)]);
    const out = retryFailed("p", env);

    expect(out).toMatch(/seam colour will be checked again/);
    expect(readRetry("p", env)).toMatchObject({ slices: [], seams: ["colour"], findings: [] });
    expect(readState("p", env)).toMatchObject({ currentStage: "build", completedStage: "build", status: "awaiting_human" });
  });

  it("retries findings that have a test, and names the ones that cannot be", () => {
    seed([], {}, { currentStage: "deliver", status: "done" });
    sfo("FINDINGS.jsonl", [
      finding("R-001", { test: "tests/review/test_r001.py" }),
      finding("R-002", { test: null }),
      finding("R-016", { round: 2, status: "report_only", test: null }),
      finding("R-003", { severity: "medium", test: "tests/review/test_r003.py" }),
    ]);
    const out = retryFailed("p", env);

    expect(readRetry("p", env)?.findings).toEqual(["R-001"]);
    expect(out).toMatch(/R-001 will get another repair round \(R-002, R-016 have no test to repair against, and stay reported\)/);
    expect(readState("p", env)).toMatchObject({ currentStage: "smoke", completedStage: "smoke" });
  });

  it("reopens the build for failed slices, and records them with the rest", () => {
    seed(["S-01"], { "S-01": 2 }, { currentStage: "deliver", status: "done" });
    sfo("SMOKE.jsonl", [smoke("colour", "failed")]);
    const out = retryFailed("p", env);

    expect(out).toMatch(/^S-01 will be attempted again.*; seam colour will be checked again/);
    expect(readState("p", env)).toMatchObject({ currentStage: "build", slicesFailed: [] });
    expect(readRetry("p", env)).toMatchObject({ slices: ["S-01"], seams: ["colour"] });
  });
});

