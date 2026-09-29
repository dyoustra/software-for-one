import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runReview, type ReviewContext } from "../../src/core/review.js";
import { readFindings } from "../../src/core/findings.js";
import { writeState } from "../../src/core/state.js";
import { writeSlices } from "../../src/core/slices.js";
import { lockTests, verifyTestLock, readTestLock } from "../../src/core/testlock.js";
import { appendDecision } from "../../src/core/decisions.js";
import type { Runner, RunStageInput, StageResult } from "../../src/runner/types.js";
import type { VerifyResult } from "../../src/core/verify.js";

let env: Record<string, string>;
let dir: string;

const PASS: VerifyResult = { ok: true, steps: [], tamperedTests: [] };
const FAIL: VerifyResult = { ok: false, steps: [], tamperedTests: [], reason: "failed" };

function git(...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, encoding: "utf8", stdio: "pipe" });
}

beforeEach(() => {
  env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-review-")) };
  dir = path.join(env.SFO_HOME, "p");
  fs.mkdirSync(path.join(dir, ".sfo"), { recursive: true });
  fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
  fs.writeFileSync(path.join(dir, "tests", "test_s01.py"), "def test_s01() -> None: pass\n");
  fs.writeFileSync(path.join(dir, "app.py"), "resolution = None\n");
  writeSlices("p", [{ id: "S-01", name: "one", criterionIds: ["AC-001"], prerequisites: [] }], env);
  writeState(
    {
      id: "p",
      title: "T",
      currentStage: "review",
      status: "running",
      attempts: {},
      slicesPassed: ["S-01"],
      pid: null,
      heartbeatAt: null,
      createdAt: "2026-09-27T00:00:00.000Z",
      updatedAt: "2026-09-27T00:00:00.000Z",
    },
    env,
  );
  lockTests("p", "tests", env);
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "built");
});

const finding = (id: string, over: object = {}) => ({
  id,
  round: 1,
  severity: "high",
  kind: "code",
  criterionId: "AC-001",
  decisionId: null,
  summary: `${id} summary`,
  evidence: `${id} evidence`,
  test: `tests/review/test_${id.toLowerCase().replace("-", "")}.py`,
  ...over,
});

/** The reviewer: writes the given findings, and a test file for each that names one. */
function reviewer(findings: object[], extra: (stage: string) => void = () => {}) {
  return (stage: string): void => {
    if (stage === "review") {
      fs.mkdirSync(path.join(dir, "tests", "review"), { recursive: true });
      for (const f of findings as { test: string | null }[]) {
        if (f.test) fs.writeFileSync(path.join(dir, f.test), "def test_it() -> None: assert False\n");
      }
      fs.writeFileSync(path.join(dir, ".sfo", "FINDINGS.jsonl"), findings.map((f) => JSON.stringify(f)).join("\n") + "\n");
      fs.writeFileSync(path.join(dir, ".sfo", "REVIEW.md"), "# Review\n");
    }
    extra(stage);
  };
}

class Agent implements Runner {
  calls: RunStageInput[] = [];
  constructor(private readonly onRun: (stage: string) => void) {}
  async runStage(input: RunStageInput): Promise<StageResult> {
    this.calls.push(input);
    this.onRun(path.basename(input.logPath, ".log"));
    return { ok: true, exitCode: 0, logPath: input.logPath };
  }
}

/** Which review tests pass, decided by what the "code" currently says. */
function codeSays(passing: (code: string, file: string) => boolean): ReviewContext["runTests"] {
  return (_id, _a, files) => {
    const code = fs.readFileSync(path.join(dir, "app.py"), "utf8");
    return files.every((f) => passing(code, f)) ? PASS : FAIL;
  };
}

function ctx(runner: Runner, over: Partial<ReviewContext> = {}): ReviewContext & { resmoked: number } {
  const c = {
    id: "p",
    env,
    runner,
    archetype: "cli-python",
    verify: () => PASS,
    suiteCheck: () => PASS,
    passedGate: () => PASS,
    runTests: codeSays(() => false),
    budgetExceeded: () => false,
    withHeartbeat: <T,>(fn: () => Promise<T>) => fn(),
    resmoked: 0,
    resmoke: async () => {
      c.resmoked++;
    },
    ...over,
  };
  return c;
}

const stages = (a: Agent): string[] => a.calls.map((c) => path.basename(c.logPath, ".log"));
const statuses = (): Record<string, string> => Object.fromEntries(readFindings("p", env).map((f) => [f.id, f.status]));

describe("review with nothing to repair", () => {
  it("reports and stops: no repair, no second smoke, no round 2", async () => {
    const agent = new Agent(reviewer([finding("R-001", { severity: "medium", test: null }), finding("R-002", { kind: "spec", test: null })]));
    const c = ctx(agent);
    await runReview(c);

    expect(stages(agent)).toEqual(["review"]);
    expect(statuses()).toEqual({ "R-001": "report_only", "R-002": "report_only" });
    expect(c.resmoked).toBe(0);
  });

  it("drops a finding against a decision the person made, and keeps one against an agent's", async () => {
    appendDecision("p", { id: "D-001", decision: "d", chose: "c", considered: "x", why: "w", decided_by: "human", blast_radius: "local", at: "2026-09-27T00:00:00.000Z" }, env);
    appendDecision("p", { id: "D-002", decision: "d", chose: "c", considered: "x", why: "w", decided_by: "agent", blast_radius: "local", at: "2026-09-27T00:00:00.000Z" }, env);
    const agent = new Agent(reviewer([finding("R-001", { decisionId: "D-001", test: null }), finding("R-002", { decisionId: "D-002", severity: "low", test: null })]));
    await runReview(ctx(agent));
    expect(statuses()).toEqual({ "R-001": "dropped", "R-002": "report_only" });
  });

  it("reverts anything the reviewer wrote outside tests/review", async () => {
    const agent = new Agent(reviewer([], () => fs.writeFileSync(path.join(dir, "app.py"), "resolution = 'patched by the reviewer'\n")));
    await runReview(ctx(agent));
    expect(fs.readFileSync(path.join(dir, "app.py"), "utf8")).toBe("resolution = None\n");
  });
});

describe("reproduction", () => {
  it("records a finding whose test already passes as not reproduced, and discards the test", async () => {
    const agent = new Agent(reviewer([finding("R-001")]));
    await runReview(ctx(agent, { runTests: codeSays(() => true) }));

    expect(statuses()).toEqual({ "R-001": "not_reproduced" });
    expect(fs.existsSync(path.join(dir, "tests/review/test_r001.py"))).toBe(false);
    expect(stages(agent)).toEqual(["review"]);
  });

  it("marks every repairable finding unrepaired when the review tests fail the pre-lock check", async () => {
    const agent = new Agent(reviewer([finding("R-001")]));
    await runReview(
      ctx(agent, {
        suiteCheck: () => ({ ok: false, steps: [{ name: "lint", ok: false, exitCode: 1, output: "E999 bad" }], tamperedTests: [] }),
      }),
    );
    const [f] = readFindings("p", env);
    expect(f.status).toBe("unrepaired");
    expect(f.statusWhy).toMatch(/do not pass lint[\s\S]*E999/);
    expect(fs.existsSync(path.join(dir, "tests/review/test_r001.py"))).toBe(false);
  });

  it("requires a test under tests/review for a repairable finding", async () => {
    const agent = new Agent(reviewer([finding("R-001", { test: null })]));
    await runReview(ctx(agent));
    expect(readFindings("p", env)[0]).toMatchObject({ status: "unrepaired", statusWhy: expect.stringMatching(/no reproduction test/) });
  });

  it("locks and commits the reproduction tests on their own", async () => {
    const agent = new Agent(reviewer([finding("R-001")]));
    await runReview(ctx(agent));

    expect(Object.keys(readTestLock("p", env))).toContain("tests/review/test_r001.py");
    const files = git("log", "--name-only", "--format=%s", "--grep=^review: reproduction");
    expect(files).toContain("tests/review/test_r001.py");
    expect(files).not.toContain("app.py");
  });

  it("refuses to lock review tests over a suite that drifted since the last lock", async () => {
    const agent = new Agent(reviewer([finding("R-001")], (stage) => {
      if (stage === "review") fs.writeFileSync(path.join(dir, "tests", "test_s01.py"), "def test_s01() -> None: assert True\n");
    }));
    await runReview(ctx(agent));
    // The reviewer's own edit to a slice test is reverted as out of bounds, so the lock holds.
    expect(verifyTestLock("p", "tests", env)).toEqual([]);
    expect(statuses()["R-001"]).toBe("unrepaired");
  });
});

describe("repair", () => {
  const fixes = (code: string) => (stage: string) => {
    if (stage === "review-repair") fs.writeFileSync(path.join(dir, "app.py"), code);
  };

  it("keeps a repair that makes the tests pass, re-runs smoke, and runs round 2 report-only", async () => {
    const agent = new Agent(
      reviewer([finding("R-001")], (stage) => {
        fixes("resolution = 'applied'\n")(stage);
        if (stage === "review-2") {
          fs.appendFileSync(path.join(dir, ".sfo", "FINDINGS.jsonl"), JSON.stringify(finding("R-002", { round: 2, test: "tests/review/test_r002.py" })) + "\n");
          fs.mkdirSync(path.join(dir, "tests", "review"), { recursive: true });
          fs.writeFileSync(path.join(dir, "tests/review/test_r002.py"), "def test_x() -> None: pass\n");
        }
      }),
    );
    const c = ctx(agent, { runTests: codeSays((code) => code.includes("applied")) });
    await runReview(c);

    expect(stages(agent)).toEqual(["review", "review-repair", "review-2"]);
    expect(statuses()).toEqual({ "R-001": "repaired", "R-002": "report_only" });
    expect(c.resmoked).toBe(1);
    expect(fs.existsSync(path.join(dir, "tests/review/test_r002.py"))).toBe(false);
    expect(git("log", "--format=%s")).toMatch(/stage\(review-repair\)/);
  });

  it("keeps partial progress and goes again for the rest", async () => {
    let round = 0;
    const agent = new Agent(
      reviewer([finding("R-001"), finding("R-002")], (stage) => {
        if (stage === "review-repair") fs.writeFileSync(path.join(dir, "app.py"), ++round === 1 ? "FIX1\n" : "FIX1 FIX2\n");
      }),
    );
    await runReview(
      ctx(agent, {
        runTests: (_i, _a, files) => {
          const code = fs.readFileSync(path.join(dir, "app.py"), "utf8");
          return files.every((f) => (f.includes("r001") ? code.includes("FIX1") : code.includes("FIX2"))) ? PASS : FAIL;
        },
      }),
    );
    expect(stages(agent)).toEqual(["review", "review-repair", "review-repair", "review-2"]);
    expect(statuses()).toEqual({ "R-001": "repaired", "R-002": "repaired" });
  });

  it("discards a repair that breaks a built slice, tells the next attempt, and gives up after two", async () => {
    const agent = new Agent(reviewer([finding("R-001")], fixes("resolution = 'applied'\n")));
    const c = ctx(agent, {
      runTests: codeSays((code) => code.includes("applied")),
      passedGate: () => ({ ok: false, steps: [{ name: "test", ok: false, exitCode: 1, output: "FAILED tests/test_s01.py" }], tamperedTests: [], reason: "test failed" }),
    });
    await runReview(c);

    expect(stages(agent)).toEqual(["review", "review-repair", "review-repair"]);
    expect(agent.calls[2].prompt).toMatch(/previous repair was discarded[\s\S]*FAILED tests\/test_s01.py/);
    expect(fs.readFileSync(path.join(dir, "app.py"), "utf8")).toBe("resolution = None\n");
    expect(readFindings("p", env)[0]).toMatchObject({ status: "unrepaired", statusWhy: "still failing after 2 repair attempts" });
    expect(c.resmoked).toBe(0);
  });

  it("gates each later attempt on the review tests already repaired", async () => {
    const gated: string[][] = [];
    let round = 0;
    const agent = new Agent(
      reviewer([finding("R-001"), finding("R-002")], (stage) => {
        if (stage === "review-repair") fs.writeFileSync(path.join(dir, "app.py"), ++round === 1 ? "FIX1\n" : "FIX1 FIX2\n");
      }),
    );
    await runReview(
      ctx(agent, {
        passedGate: (_i, _a, _p, _e, extra = []) => {
          gated.push(extra);
          return PASS;
        },
        runTests: (_i, _a, files) => {
          const code = fs.readFileSync(path.join(dir, "app.py"), "utf8");
          return files.every((f) => (f.includes("r001") ? code.includes("FIX1") : code.includes("FIX2"))) ? PASS : FAIL;
        },
      }),
    );
    expect(gated).toEqual([[], ["tests/review/test_r001.py"]]);
  });

  it("stops before a repair when the budget is spent", async () => {
    const agent = new Agent(reviewer([finding("R-001")]));
    const out = await runReview(ctx(agent, { budgetExceeded: () => true }));
    expect(out).toEqual({ outcome: "budget", stage: "review-repair" });
    expect(stages(agent)).toEqual(["review"]);
  });

  it("discards a repair that breaks nothing but fixes nothing either", async () => {
    const agent = new Agent(reviewer([finding("R-001")], fixes("resolution = 'rearranged'\n")));
    const c = ctx(agent, { runTests: codeSays((code) => code.includes("applied")) });
    await runReview(c);

    expect(fs.readFileSync(path.join(dir, "app.py"), "utf8")).toBe("resolution = None\n");
    expect(agent.calls[2].prompt).toContain("none of the findings' tests pass yet");
    expect(statuses()).toEqual({ "R-001": "unrepaired" });
    expect(c.resmoked).toBe(0);
  });
});


describe("a repair that caused a regression", () => {
  const regression = (over: object) => (stage: string) => {
    if (stage === "review-repair") fs.writeFileSync(path.join(dir, "app.py"), "resolution = 'applied'\n");
    if (stage === "review-2") {
      fs.appendFileSync(
        path.join(dir, ".sfo", "FINDINGS.jsonl"),
        JSON.stringify(finding("R-002", { round: 2, test: null, summary: "the repair broke links", ...over })) + "\n",
      );
    }
  };

  it("is rolled back: the code before it returns, and its finding is open again", async () => {
    const agent = new Agent(reviewer([finding("R-001")], regression({ causedBy: "R-001" })));
    await runReview(ctx(agent, { runTests: codeSays((code) => code.includes("applied")) }));

    expect(fs.readFileSync(path.join(dir, "app.py"), "utf8")).toBe("resolution = None\n");
    const byId = Object.fromEntries(readFindings("p", env).map((f) => [f.id, f]));
    expect(byId["R-001"]).toMatchObject({ status: "unrepaired", statusWhy: "repair rolled back: it introduced R-002" });
    expect(byId["R-002"].status).toBe("rolled_back");
    expect(git("log", "--format=%s", "-1")).toMatch(/^Revert/);
  });

  it("is left in place when the regression is not high, or names no repair", async () => {
    const agent = new Agent(reviewer([finding("R-001")], regression({ causedBy: "R-001", severity: "medium" })));
    await runReview(ctx(agent, { runTests: codeSays((code) => code.includes("applied")) }));
    expect(fs.readFileSync(path.join(dir, "app.py"), "utf8")).toBe("resolution = 'applied'\n");
    expect(Object.fromEntries(readFindings("p", env).map((f) => [f.id, f.status]))).toEqual({ "R-001": "repaired", "R-002": "report_only" });
  });

  it("is reported, not forced, when the revert conflicts with later work", async () => {
    const agent = new Agent(
      reviewer([finding("R-001")], (stage) => {
        regression({ causedBy: "R-001" })(stage);
        if (stage === "review-2") {
          // Later work on the same line: a revert of the repair now conflicts.
          fs.writeFileSync(path.join(dir, "app.py"), "resolution = 'applied, then changed'\n");
          git("commit", "-q", "-am", "later work");
        }
      }),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await runReview(ctx(agent, { runTests: codeSays((code) => code.includes("applied")) }));
    error.mockRestore();

    expect(fs.readFileSync(path.join(dir, "app.py"), "utf8")).toBe("resolution = 'applied, then changed'\n");
    const r2 = readFindings("p", env).find((f) => f.id === "R-002");
    expect(r2?.status).toBe("report_only");
    expect(r2?.statusWhy).toMatch(/rollback failed — could not revert/);
    // Nothing half-applied: outside .sfo/, the tree is exactly the last commit.
    expect(git("status", "--porcelain", "--", ".", ":(exclude).sfo")).toBe("");
  });
});

describe("a finding that says a test is wrong", () => {
  it("goes to the adjudicator, and an amendment resolves it", async () => {
    const agent = new Agent(
      reviewer([finding("R-001", { kind: "test", severity: "medium", test: null, testFile: "tests/test_s01.py" })], (stage) => {
        if (stage.startsWith("adjudicate-")) {
          fs.writeFileSync(path.join(dir, "tests", "test_s01.py"), "def test_s01() -> None: assert 1\n");
          fs.writeFileSync(
            path.join(dir, ".sfo", "RULING.json"),
            JSON.stringify({ ruling: "amend_test", why: "it read the wrong file", changedFiles: [], question: null }),
          );
        }
      }),
    );
    await runReview(ctx(agent));

    expect(stages(agent)).toEqual(["review", "adjudicate-REVIEW-R-001"]);
    expect(readFindings("p", env)[0]).toMatchObject({ status: "repaired", statusWhy: "the adjudicator amended tests/test_s01.py" });
    expect(verifyTestLock("p", "tests", env)).toEqual([]);
  });

  it("stays reported when the adjudicator upholds the test", async () => {
    const agent = new Agent(
      reviewer([finding("R-001", { kind: "test", severity: "medium", test: null, testFile: "tests/test_s01.py" })], (stage) => {
        if (stage.startsWith("adjudicate-")) {
          fs.writeFileSync(path.join(dir, ".sfo", "RULING.json"), JSON.stringify({ ruling: "uphold", why: "it is fine", changedFiles: [], question: null }));
        }
      }),
    );
    await runReview(ctx(agent));
    expect(readFindings("p", env)[0]).toMatchObject({ status: "report_only", statusWhy: expect.stringMatching(/upheld tests\/test_s01.py: it is fine/) });
  });
});
