import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { advance, type VerifyFn, type SuiteCheckFn } from "../../src/core/orchestrator.js";
import { writeState, readState, type ProjectState } from "../../src/core/state.js";
import { writeCriteria } from "../../src/core/criteria.js";
import { writeSlices, type Slice } from "../../src/core/slices.js";
import { readTestLock, verifyTestLock, TEST_LOCK_FILE } from "../../src/core/testlock.js";
import { readCostRecords } from "../../src/core/cost.js";
import { writeBudget } from "../../src/core/budget.js";
import { readDecisions } from "../../src/core/decisions.js";
import { readVerifyRecords } from "../../src/core/verifyRecord.js";
import { runRecipe } from "../../src/core/verify.js";
import { projectDir } from "../../src/core/paths.js";
import { ARCHETYPE_FILE } from "../../src/core/stack.js";
import type { VerifyStep } from "../../src/core/archetype.js";
import { listProjects, formatStatus } from "../../src/commands/status.js";
import type { Runner, RunStageInput, StageResult, StageUsage } from "../../src/runner/types.js";


/**
 * The pre-lock check shells out to the project's real toolchain (uv, ruff,
 * mypy), which these fixtures only fake a manifest for. It passes by default
 * here; the tests of the check itself inject a verdict through `suiteCheck`.
 */
vi.mock("../../src/core/verify.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/core/verify.js")>();
  return {
    ...real,
    checkSuiteBeforeLock: () => ({ ok: true, steps: [], tamperedTests: [] }),
  };
});

let env: Record<string, string>;

const USAGE: StageUsage = {
  costUsd: 0.05,
  durationMs: 1000,
  numTurns: 1,
  inputTokens: 2,
  outputTokens: 4,
  cacheCreationInputTokens: 10,
  cacheReadInputTokens: 20,
};

class FakeRunner implements Runner {
  calls: RunStageInput[] = [];
  constructor(
    private readonly ok = true,
    private readonly delayMs = 0,
    private readonly usage: StageUsage | undefined = undefined,
    /** Stands in for a stage rewriting artifacts while it runs. */
    private readonly onRun?: (stage: string) => void,
  ) {}
  async runStage(input: RunStageInput): Promise<StageResult> {
    this.calls.push(input);
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    this.onRun?.(stageOf(input));
    return {
      ok: this.ok,
      exitCode: this.ok ? 0 : 1,
      logPath: input.logPath,
      usage: this.usage,
    };
  }
}

/** The stage a call was for, read back the way the runner names its log. */
function stageOf(input: RunStageInput): string {
  return path.basename(input.logPath, ".log");
}

const CRITERIA = [
  { id: "AC-001", group: "G", text: "one" },
  { id: "AC-002", group: "G", text: "two" },
  { id: "AC-003", group: "G", text: "three" },
];

/** Two slices in a chain and one independent, so a failure can skip a dependent. */
const SLICES: Slice[] = [
  { id: "S-01", name: "Enumeration", criterionIds: ["AC-001"], prerequisites: [] },
  { id: "S-02", name: "Naming", criterionIds: ["AC-002"], prerequisites: ["S-01"] },
  { id: "S-03", name: "Reporting", criterionIds: ["AC-003"], prerequisites: [] },
];

/**
 * What the real stages leave on disk for the ones after them. The build has no
 * slices and test-repair has no suite to freeze unless these files exist, and
 * both of those are genuine pipeline failures — so a test that wants to reach
 * the build has to produce them the way the pipeline does, at the stage that
 * produces them.
 */
function producesArtifacts(
  slices: Slice[] = SLICES,
  /**
   * The stack the spec stage recorded, written as text the way it writes it.
   * `null` means it recorded none — deliberately not `undefined`, which would
   * be swallowed by the caller's default parameter and silently yield one.
   */
  archetype: string | null = "cli-python",
): (stage: string) => void {
  return (stage) => {
    if (stage === "spec") writeCriteria("p", CRITERIA, env);
    if (stage === "spec" && archetype !== null) {
      fs.writeFileSync(
        path.join(env.SFO_HOME, "p", ".sfo", ARCHETYPE_FILE),
        `{"archetype":"${archetype}","why":"the idea is a CLI"}`,
      );
    }
    if (stage === "plan") writeSlices("p", slices, env);
    // test-repair scaffolds the toolchain in production, so the fake does too.
    // Without it every fixture models a project the pipeline can no longer
    // produce — one whose gate could never have run.
    if (stage === "test-repair" && archetype === "cli-python") {
      fs.writeFileSync(
        path.join(env.SFO_HOME, "p", "pyproject.toml"),
        '[project]\nname = "p"\nversion = "0.1.0"\n',
      );
    }
    if (stage === "test-repair" && archetype === "cli-node") {
      fs.writeFileSync(
        path.join(env.SFO_HOME, "p", "package.json"),
        '{"name":"p","scripts":{"lint":"true","typecheck":"true","test":"true"}}',
      );
    }
    if (stage === "test-write") {
      const dir = path.join(env.SFO_HOME, "p", "tests");
      fs.mkdirSync(dir, { recursive: true });
      for (const s of slices) {
        const name = s.id.toLowerCase().replace(/[^a-z0-9]/g, "");
        fs.writeFileSync(path.join(dir, `test_${name}.py`), `def test_${name}(): assert False\n`);
      }
    }
  };
}

/** Runs the whole pipeline as far as it will go, artifacts and all. */
function pipelineRunner(archetype: string | null = "cli-python"): FakeRunner {
  return new FakeRunner(true, 0, undefined, producesArtifacts(SLICES, archetype));
}

/** A step that really runs, and exits how it is told to. */
function exits(name: string, code: number): VerifyStep {
  return {
    name,
    command: process.execPath,
    args: ["-e", `process.exit(${code})`],
    scopeable: false,
  };
}

/**
 * A gate that runs two real steps and fails on the second, through the same
 * `runRecipe` production uses — so the verdict it produces is shaped by the
 * step machinery rather than by hand.
 */
const STOPS_AT_TEST: VerifyFn = (id, _archetype, _slice, e) =>
  runRecipe(projectDir(id, e), [exits("lint", 0), exits("test", 1)], []);

const PASSES: VerifyFn = () => ({ ok: true, steps: [], tamperedTests: [] });
const FAILS: VerifyFn = () => ({ ok: false, steps: [], tamperedTests: [], reason: "gate failed" });

/** Fails the named slices, passes the rest. */
function failing(...ids: string[]): VerifyFn {
  return (id, archetype, slice, env) =>
    ids.includes(slice.id) ? FAILS(id, archetype, slice, env) : PASSES(id, archetype, slice, env);
}

/**
 * Every stage succeeds except the build agent, which exits non-zero — the
 * project reaches the slice loop and then fails inside it.
 */
class BuildFailsRunner implements Runner {
  calls: RunStageInput[] = [];
  constructor(private readonly archetype: string) {}
  async runStage(input: RunStageInput): Promise<StageResult> {
    this.calls.push(input);
    const stage = stageOf(input);
    producesArtifacts(SLICES, this.archetype)(stage);
    const ok = !stage.startsWith("build-");
    return { ok, exitCode: ok ? 0 : 1, logPath: input.logPath };
  }
}

/** Dies mid-stage the way a dropped connection does: no state written, no result. */
class KilledRunner implements Runner {
  calls: RunStageInput[] = [];
  constructor(
    private readonly killAt: string,
    private readonly onRun: (stage: string) => void,
  ) {}
  async runStage(input: RunStageInput): Promise<StageResult> {
    this.calls.push(input);
    const stage = stageOf(input);
    if (stage === this.killAt) throw new Error("connection dropped");
    this.onRun(stage);
    return { ok: true, exitCode: 0, logPath: input.logPath };
  }
}

function sliceStages(runner: FakeRunner): string[] {
  return runner.calls.map(stageOf).filter((s) => s.startsWith("build-"));
}

function seed(stage: string, id = "p"): ProjectState {
  const s: ProjectState = {
    id,
    title: "T",
    currentStage: stage,
    status: "awaiting_human",
    attempts: {},
    sliceAttempts: {},
    slicesPassed: [],
    slicesFailed: [],
    completedStage: null,
    pid: null,
    heartbeatAt: null,
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
  };
  fs.mkdirSync(path.join(env.SFO_HOME, id, ".sfo"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: path.join(env.SFO_HOME, id) });
  writeState(s, env);
  return s;
}

/** Commit subjects, newest last. Empty on an unborn branch. */
function subjects(): string[] {
  try {
    const out = execFileSync("git", ["log", "--reverse", "--format=%s"], {
      cwd: path.join(env.SFO_HOME, "p"),
      encoding: "utf8",
      stdio: "pipe",
    });
    return out.split("\n").filter(Boolean);
  } catch {
    return []; // unborn branch: no commits yet
  }
}

beforeEach(() => {
  env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-orch-")) };
});

describe("advance", () => {
  it("runs every stage up to the human gate", async () => {
    seed("capture");
    const runner = new FakeRunner();
    await advance("p", runner, env);

    expect(runner.calls.map((c) => path.basename(c.logPath))).toEqual([
      "research.log",
      "spec.log",
    ]);
    expect(readState("p", env).currentStage).toBe("clarify");
    expect(readState("p", env).status).toBe("awaiting_human");
  });

  it("marks the project failed when a stage exits non-zero", async () => {
    seed("capture");
    await advance("p", new FakeRunner(false), env);
    const s = readState("p", env);
    expect(s.status).toBe("failed");
    expect(s.currentStage).toBe("research");
    expect(s.attempts.research).toBe(1);
  });

  it("records a heartbeat while running", async () => {
    seed("capture");
    await advance("p", new FakeRunner(), env);
    expect(readState("p", env).heartbeatAt).not.toBeNull();
  });

  it("clears pid when it stops", async () => {
    seed("capture");
    await advance("p", new FakeRunner(), env);
    expect(readState("p", env).pid).toBeNull();
  });

  it("runs the parked clarify stage after the human answers, via the real resume path", async () => {
    // Walks the state the pipeline actually produces. Seeding currentStage
    // "spec" with ANSWERS.md already present passes against a broken
    // orchestrator, because parking sets currentStage to "clarify" — asking
    // nextStage("clarify") then returns null and the project is marked done
    // having never run the stage that folds in the answers.
    seed("capture");
    const first = pipelineRunner();
    await advance("p", first, env, { verify: PASSES });

    expect(first.calls.map((c) => path.basename(c.logPath))).toEqual([
      "research.log",
      "spec.log",
    ]);
    expect(readState("p", env).currentStage).toBe("clarify");
    expect(readState("p", env).status).toBe("awaiting_human");

    // The human answers.
    fs.writeFileSync(path.join(env.SFO_HOME, "p", ".sfo", "ANSWERS.json"), '{"answers":[]}');

    const resumed = pipelineRunner();
    await advance("p", resumed, env, { verify: PASSES });

    // The point of this test is the resume, so it asserts clarify ran FIRST
    // rather than pinning the whole downstream sequence — that belongs in
    // stages.test.ts, and duplicating it here means every future stage breaks
    // a test about resuming.
    const resumedLogs = resumed.calls.map((c) => path.basename(c.logPath));
    expect(resumedLogs[0]).toBe("clarify.log");
    expect(resumedLogs).not.toContain("research.log");
    expect(readState("p", env).status).toBe("done");
  });

  it("does not run clarify twice when advanced again after it completed", async () => {
    seed("capture");
    await advance("p", pipelineRunner(), env, { verify: PASSES });
    fs.writeFileSync(path.join(env.SFO_HOME, "p", ".sfo", "ANSWERS.json"), '{"answers":[]}');
    await advance("p", pipelineRunner(), env, { verify: PASSES });
    expect(readState("p", env).status).toBe("done");

    const again = pipelineRunner();
    await advance("p", again, env, { verify: PASSES });
    expect(again.calls).toHaveLength(0);
  });

  it("keeps ticking the heartbeat while a stage is running", async () => {
    seed("capture");
    // Stage outlives the 120s staleness window in spirit: several ticks must
    // land while the runner is still working, or a healthy long run reads dead.
    const runner = new FakeRunner(true, 60);
    const before = new Date().toISOString();
    await advance("p", runner, env, { heartbeatMs: 10 });

    const after = readState("p", env).heartbeatAt;
    expect(after).not.toBeNull();
    expect(new Date(after as string).getTime()).toBeGreaterThan(new Date(before).getTime());
  });

  it("refuses to advance a failed project instead of skipping the failed stage", async () => {
    seed("capture");
    await advance("p", new FakeRunner(false), env);
    expect(readState("p", env).status).toBe("failed");
    expect(readState("p", env).currentStage).toBe("research");

    const resumed = new FakeRunner();
    await expect(advance("p", resumed, env)).rejects.toThrow(/failed at stage "research"/);
    expect(resumed.calls).toHaveLength(0);
    expect(readState("p", env).currentStage).toBe("research");
  });

  it("never launders a failed clarify into done", async () => {
    seed("clarify");
    const s = readState("p", env);
    writeState({ ...s, status: "failed" }, env);

    await expect(advance("p", new FakeRunner(), env)).rejects.toThrow(/failed at stage "clarify"/);
    expect(readState("p", env).status).toBe("failed");
  });

  it("records cost for a stage that failed, not only for ones that succeeded", async () => {
    // A failed stage still burned tokens. Recording only the happy path would
    // under-report the bill by exactly the amount of the wasted work.
    seed("capture");
    await advance("p", new FakeRunner(false, 0, USAGE), env);

    const records = readCostRecords("p", env);
    expect(records).toHaveLength(1);
    expect(records[0].stage).toBe("research");
    expect(records[0].ok).toBe(false);
    expect(records[0].usage.costUsd).toBe(0.05);
  });

  it("records one cost line per stage it ran", async () => {
    seed("capture");
    await advance("p", new FakeRunner(true, 0, USAGE), env);
    expect(readCostRecords("p", env).map((r) => r.stage)).toEqual(["research", "spec"]);
  });

  it("writes no cost file when the runner reports no usage", async () => {
    seed("capture");
    await advance("p", new FakeRunner(), env);
    expect(readCostRecords("p", env)).toEqual([]);
  });

  it("commits after every stage it completes, so each one is diffable", async () => {
    seed("capture");
    await advance("p", new FakeRunner(), env);

    expect(subjects()).toEqual([
      expect.stringContaining("stage(research)"),
      expect.stringContaining("stage(spec)"),
    ]);
  });

  it("does not commit a failed stage, so the retry diffs against the last good state", async () => {
    seed("capture");
    await advance("p", new FakeRunner(false), env);

    expect(subjects()).toEqual([]);
  });

  it("stops after research when prior art says the gap is not real", async () => {
    seed("capture");
    const runner = new FakeRunner(true, 0, undefined, () =>
      fs.writeFileSync(
        path.join(env.SFO_HOME, "p", ".sfo", "PRIOR_ART.json"),
        JSON.stringify({
          verdict: "no_gap",
          summary: "Several mature tools do exactly this.",
          existing: [{ name: "ai-renamer", url: "https://example.com", gap: "none" }],
          recommendation: "use ai-renamer",
        }),
      ),
    );

    await advance("p", runner, env);

    expect(runner.calls.map((c) => path.basename(c.logPath))).toEqual(["research.log"]);
    expect(readState("p", env).status).toBe("awaiting_human");
    expect(readState("p", env).currentStage).toBe("research");
  });

  it("proceeds past research when the gap is real", async () => {
    seed("capture");
    const runner = new FakeRunner(true, 0, undefined, () =>
      fs.writeFileSync(
        path.join(env.SFO_HOME, "p", ".sfo", "PRIOR_ART.json"),
        JSON.stringify({
          verdict: "clear_gap",
          summary: "Nothing covers this.",
          existing: [],
        }),
      ),
    );

    await advance("p", runner, env);
    expect(runner.calls.map((c) => path.basename(c.logPath))).toContain("spec.log");
  });

});

describe("criteria drift", () => {
  it("warns when a stage drops criteria it was supposed to carry through", async () => {
    seed("capture");
    writeCriteria(
      "p",
      [
        { id: "AC-001", group: "G", text: "one" },
        { id: "AC-002", group: "G", text: "two" },
      ],
      env,
    );

    // A stage that rewrites the file and loses a record from the tail. This
    // fails silently without the check: nothing throws, the contract just shrinks.
    const dropper = new FakeRunner(true, 0, undefined, () =>
      writeCriteria("p", [{ id: "AC-001", group: "G", text: "one" }], env),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await advance("p", dropper, env);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("AC-002"));
    warn.mockRestore();
  });

  it("stays quiet when every criterion survives", async () => {
    seed("capture");
    writeCriteria("p", [{ id: "AC-001", group: "G", text: "one" }], env);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await advance("p", new FakeRunner(), env);

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("budget ceiling", () => {
  /** Spends the ceiling through the pipeline itself rather than seeding a bill. */
  async function spendToTheCeiling(): Promise<void> {
    seed("capture");
    writeBudget("p", USAGE.costUsd, env);
    await advance("p", new FakeRunner(true, 0, USAGE), env);
  }

  it("parks before the next stage rather than after paying for it", async () => {
    // research costs exactly the ceiling. Checking after recording cost would
    // let spec run too — an overshoot of a whole stage, which at real prices
    // ($0.30–$1.25 a stage) is an overrun, not a rounding error.
    await spendToTheCeiling();

    expect(readCostRecords("p", env).map((r) => r.stage)).toEqual(["research"]);
    const s = readState("p", env);
    expect(s.status).toBe("awaiting_human");
    expect(s.pid).toBeNull();
  });

  it("runs nothing at all when the project is already over its ceiling", async () => {
    await spendToTheCeiling();

    const again = new FakeRunner(true, 0, USAGE);
    await advance("p", again, env);

    expect(again.calls).toHaveLength(0);
    expect(readCostRecords("p", env)).toHaveLength(1);
  });

  it("resumes the stage the ceiling refused once the ceiling is raised", async () => {
    // The stage never ran, so parking must not move currentStage onto it:
    // pickStage would then ask for the stage *after* it and the refused work
    // would be skipped, silently, exactly when the user paid to continue.
    await spendToTheCeiling();
    writeBudget("p", 100, env);

    const resumed = new FakeRunner(true, 0, USAGE);
    await advance("p", resumed, env);

    expect(resumed.calls.map((c) => path.basename(c.logPath))).toEqual(["spec.log"]);
    expect(readState("p", env).currentStage).toBe("clarify");
  });

  it("leaves a project with no ceiling alone, however much it spends", async () => {
    seed("capture");
    const runner = new FakeRunner(true, 0, { ...USAGE, costUsd: 1000 });
    await advance("p", runner, env);

    expect(runner.calls.map((c) => path.basename(c.logPath))).toEqual([
      "research.log",
      "spec.log",
    ]);
    expect(readState("p", env).currentStage).toBe("clarify");
  });

  it("runs on when spend is still under the ceiling", async () => {
    seed("capture");
    writeBudget("p", USAGE.costUsd * 10, env);
    const runner = new FakeRunner(true, 0, USAGE);
    await advance("p", runner, env);

    expect(runner.calls).toHaveLength(2);
    expect(readState("p", env).status).toBe("awaiting_human");
    expect(readState("p", env).currentStage).toBe("clarify");
  });

  it("records the halt as a decision, with the numbers that forced it", async () => {
    await spendToTheCeiling();

    const decisions = readDecisions("p", env);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].decided_by).toBe("agent");
    expect(decisions[0].blast_radius).toBe("external");
    expect(decisions[0].why).toContain("0.05");
    expect(decisions[0].decision).toContain("spec");
  });

  it("does not re-record the same halt every time the user retries", async () => {
    await spendToTheCeiling();
    await advance("p", new FakeRunner(true, 0, USAGE), env);
    await advance("p", new FakeRunner(true, 0, USAGE), env);

    expect(readDecisions("p", env)).toHaveLength(1);
  });

  it("tells a budget park apart from one that is waiting on the human", async () => {
    // Both are `awaiting_human`. Collapsing them tells someone who is out of
    // money to go answer questions, and vice versa.
    seed("capture", "broke");
    writeBudget("broke", USAGE.costUsd, env);
    await advance("broke", new FakeRunner(true, 0, USAGE), env);

    seed("capture", "asking");
    await advance("asking", new FakeRunner(true, 0, USAGE), env);

    expect(readState("broke", env).currentStage).toBe("research");
    expect(readState("asking", env).currentStage).toBe("clarify");

    const out = formatStatus(listProjects(env));
    expect(out).toMatch(/broke .*over budget/);
    expect(out).toMatch(/asking .*needs you/);
  });
});

/** Drives the real pipeline from capture, through the human gate, into the build. */
async function runPipeline(runner: Runner, opts: { verify?: VerifyFn } = {}): Promise<void> {
  seed("capture");
  await advance("p", runner, env, opts);
  fs.writeFileSync(path.join(env.SFO_HOME, "p", ".sfo", "ANSWERS.json"), '{"answers":[]}');
  await advance("p", runner, env, opts);
}

describe("freezing the test suite", () => {
  it("locks every test file once test-repair has finished", async () => {
    await runPipeline(pipelineRunner(), { verify: PASSES });

    expect(Object.keys(readTestLock("p", env))).toHaveLength(SLICES.length);
  });

  it("notices a test edited after the lock", async () => {
    await runPipeline(pipelineRunner(), { verify: PASSES });
    fs.writeFileSync(path.join(env.SFO_HOME, "p", "tests", "test_s01.py"), "def test_s01(): pass\n");

    expect(verifyTestLock("p", "tests", env)).toEqual(["tests/test_s01.py"]);
  });

  it("fails at test-repair rather than build against a suite that does not exist", async () => {
    // An empty test tree means test-write produced nothing. Carrying on would
    // build, verify and deliver a project whose gates check nothing at all.
    const noTests = new FakeRunner(true, 0, undefined, (stage) => {
      if (stage === "spec") writeCriteria("p", CRITERIA, env);
      if (stage === "plan") writeSlices("p", SLICES, env);
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await runPipeline(noTests, { verify: PASSES });

    const s = readState("p", env);
    expect(s.status).toBe("failed");
    expect(s.currentStage).toBe("test-repair");
    expect(sliceStages(noTests)).toEqual([]);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("cannot freeze the test suite"));
    error.mockRestore();
  });
});

describe("the slice loop", () => {
  it("builds every slice in order and commits each one that passes", async () => {
    const runner = pipelineRunner();
    await runPipeline(runner, { verify: PASSES });

    expect(sliceStages(runner)).toEqual(["build-S-01", "build-S-02", "build-S-03"]);
    expect(readState("p", env).slicesPassed).toEqual(["S-01", "S-02", "S-03"]);
    // One commit per slice, so a killed run resumes against a clean tree.
    expect(subjects().filter((s) => s.startsWith("stage(build-S-"))).toHaveLength(3);
    expect(subjects().some((s) => s.startsWith("stage(build-S-01)"))).toBe(true);
  });

  it("gives up on a slice after two attempts, skips its dependents, and builds the rest", async () => {
    const runner = pipelineRunner();
    await runPipeline(runner, { verify: failing("S-01") });

    // S-02 depends on S-01, so it is never attempted; S-03 does not, so it is.
    expect(sliceStages(runner)).toEqual(["build-S-01", "build-S-01", "build-S-03"]);
    const s = readState("p", env);
    expect(s.sliceAttempts["S-01"]).toBe(2);
    expect(s.slicesFailed).toEqual(["S-01"]);
    expect(s.slicesPassed).toEqual(["S-03"]);
  });

  it("keeps slice attempts out of the stage retry counter", async () => {
    const runner = pipelineRunner();
    await runPipeline(runner, { verify: failing("S-01") });

    // Two dictionaries, so nothing reading `attempts` by stage name can mistake
    // a slice for a stage that has been retried.
    expect(readState("p", env).attempts).toEqual({});
  });

  it("resumes at the next unbuilt slice after a run is killed mid-build", async () => {
    // A dropped connection mid-slice is the failure this loop exists for: the
    // run dies with S-01 built and paid for, and must not build it again.
    const killed = new KilledRunner("build-S-02", producesArtifacts());
    seed("capture");
    await advance("p", killed, env, { verify: PASSES });
    fs.writeFileSync(path.join(env.SFO_HOME, "p", ".sfo", "ANSWERS.json"), '{"answers":[]}');
    await expect(advance("p", killed, env, { verify: PASSES })).rejects.toThrow(/connection/);

    expect(readState("p", env).slicesPassed).toEqual(["S-01"]);

    const resumed = pipelineRunner();
    await advance("p", resumed, env, { verify: PASSES });

    expect(sliceStages(resumed)).toEqual(["build-S-02", "build-S-03"]);
    expect(readState("p", env).slicesPassed).toEqual(["S-01", "S-02", "S-03"]);
    expect(readState("p", env).status).toBe("done");
  });

  it("fails the build when the plan left no slices to build", async () => {
    const noSlices = new FakeRunner(true, 0, undefined, (stage) => {
      if (stage === "spec") writeCriteria("p", CRITERIA, env);
      if (stage === "test-write") {
        const dir = path.join(env.SFO_HOME, "p", "tests");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "test_s01.py"), "def test_s01(): assert False\n");
      }
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await runPipeline(noSlices, { verify: PASSES });

    expect(readState("p", env).status).toBe("failed");
    expect(readState("p", env).currentStage).toBe("build");
    error.mockRestore();
  });

  it("refuses to start a build it could never have graded, before spending on one", async () => {
    // No archetype and no manifest, so no recipe exists. "Nothing to check"
    // must not read as "everything checks out" — and finding that out is worth
    // nothing if it costs two attempts on every slice to say it.
    const runner = pipelineRunner(null);
    await runPipeline(runner, {});

    const s = readState("p", env);
    expect(s.status).toBe("failed");
    expect(s.slicesPassed).toEqual([]);
    expect(s.slicesFailed).toEqual([]);
    expect(runner.calls.filter((c) => stageOf(c).startsWith("build-"))).toHaveLength(0);
  });

  it("runs the real gate when none is injected rather than assuming a pass", async () => {
    // The gate itself is wired by default; this is the only test that reaches
    // runVerify without an injected seam.
    const runner = pipelineRunner();
    await runPipeline(runner, {});

    const s = readState("p", env);
    expect(s.slicesPassed).toEqual([]);
    expect(s.slicesFailed).toEqual(["S-01", "S-03"]);
  });
});

describe("what a build agent is told", () => {
  function promptsFor(runner: FakeRunner, slice: string): string[] {
    return runner.calls.filter((c) => stageOf(c) === `build-${slice}`).map((c) => c.prompt);
  }

  it("gives each slice the exact commands its gate will run, scoped to its tests", async () => {
    const runner = pipelineRunner("cli-python");
    await runPipeline(runner, { verify: PASSES });

    const [prompt] = promptsFor(runner, "S-01");
    expect(prompt).toContain("uv run ruff check .");
    expect(prompt).toContain("uv run mypy --strict .");
    expect(prompt).toContain("uv run pytest -q --ignore=smoke tests/test_s01.py");
    expect(prompt).not.toContain("previous attempt");
  });

  it("lets a build slice run its toolchain, and research only the web and inspection", async () => {
    // With edits only, every build agent on the first real project was denied
    // uv, pytest, ruff and mypy, and wrote code it could never run.
    const runner = pipelineRunner("cli-python");
    await runPipeline(runner, { verify: PASSES });

    const build = runner.calls.find((c) => stageOf(c) === "build-S-01");
    const research = runner.calls.find((c) => stageOf(c) === "research");
    expect(build?.allowedTools).toContain("Bash(uv *)");
    expect(research?.allowedTools).toContain("WebSearch");
    expect(research?.allowedTools).not.toContain("Bash(uv *)");
  });

  it("shows a retry what the failed attempt's gate reported", async () => {
    // Without it a retry starts from the same prompt as the attempt that
    // failed, and can only find out what went wrong by failing again.
    const runner = pipelineRunner("cli-python");
    await runPipeline(runner, { verify: STOPS_AT_TEST });

    const [first, second] = promptsFor(runner, "S-01");
    expect(first).not.toContain("previous attempt");
    expect(second).toContain("Your previous attempt at this slice failed the gate");
    expect(second).toContain("[exit 1] test");
  });
});

describe("the suite is checked before it is locked", () => {
  const LINT_FAILS: SuiteCheckFn = (id, e) =>
    runRecipe(projectDir(id, e), [exits("install", 0), exits("lint", 1)], []);

  it("fails test-repair and leaves the suite unlocked when lint fails", async () => {
    // A lint error in a locked test file is one no slice can fix, so every
    // slice would fail its gate. On the first real project four such errors
    // were locked in and the whole build was lost to them.
    const runner = pipelineRunner();
    seed("capture");
    await advance("p", runner, env, { verify: PASSES, suiteCheck: LINT_FAILS });
    fs.writeFileSync(path.join(env.SFO_HOME, "p", ".sfo", "ANSWERS.json"), '{"answers":[]}');
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await advance("p", runner, env, { verify: PASSES, suiteCheck: LINT_FAILS });

    const s = readState("p", env);
    expect(s.status).toBe("failed");
    expect(s.currentStage).toBe("test-repair");
    expect(fs.existsSync(path.join(env.SFO_HOME, "p", ".sfo", TEST_LOCK_FILE))).toBe(false);
    expect(sliceStages(runner)).toEqual([]);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/does not pass lint/));
    error.mockRestore();
  });

  it("locks the suite when the check passes", async () => {
    const runner = pipelineRunner();
    await runPipeline(runner, { verify: PASSES });

    expect(fs.existsSync(path.join(env.SFO_HOME, "p", ".sfo", TEST_LOCK_FILE))).toBe(true);
  });
});

describe("projects finished under an older, shorter pipeline", () => {
  it("continues a project Phase 1 marked done at clarify, starting at plan", async () => {
    // Written as Phase 1 wrote it: raw JSON with no slice fields at all, done
    // at the stage that used to be last. Every project from that era is in
    // exactly this state on disk.
    seed("capture");
    writeCriteria("p", CRITERIA, env);
    fs.writeFileSync(path.join(env.SFO_HOME, "p", ".sfo", "ANSWERS.json"), '{"answers":[]}');
    fs.writeFileSync(
      path.join(env.SFO_HOME, "p", ".sfo", "state.json"),
      JSON.stringify({
        id: "p",
        title: "T",
        currentStage: "clarify",
        status: "done",
        attempts: { research: 1 },
        pid: null,
        heartbeatAt: null,
        createdAt: "2026-08-21T00:00:00.000Z",
        updatedAt: "2026-08-21T00:00:00.000Z",
      }),
    );

    const runner = pipelineRunner();
    await advance("p", runner, env, { verify: PASSES });

    const stages = runner.calls.map((c) => stageOf(c));
    expect(stages[0]).toBe("plan");
    expect(stages).not.toContain("clarify");
    expect(stages).not.toContain("research");
    expect(readState("p", env).status).toBe("done");
    expect(readState("p", env).currentStage).toBe("deliver");
  });

  it("still does nothing for a project done at the last stage", async () => {
    seed("capture");
    const s = readState("p", env);
    writeState({ ...s, currentStage: "deliver", status: "done" }, env);

    const runner = pipelineRunner();
    await advance("p", runner, env, { verify: PASSES });

    expect(runner.calls).toHaveLength(0);
  });
});

describe("the plan's own estimate against the ceiling", () => {
  /** research, spec, clarify, plan: what has run when the gate is checked. */
  const PRE_ESTIMATE_STAGES = 4;

  /** Stages the estimate covers that ran — should be none when it refuses. */
  function coveredStages(runner: FakeRunner): string[] {
    return runner.calls
      .map((c) => stageOf(c))
      .filter((st) => st === "test-write" || st === "test-repair" || st.startsWith("build-"));
  }

  /**
   * The plan stage writes this the way a model does — as a line of JSON into
   * ESTIMATE.jsonl, validated on read like every other artifact.
   */
  function estimating(lowUsd: number, highUsd: number): (stage: string) => void {
    const base = producesArtifacts();
    return (stage) => {
      base(stage);
      if (stage === "plan") {
        fs.appendFileSync(
          path.join(env.SFO_HOME, "p", ".sfo", "ESTIMATE.jsonl"),
          `${JSON.stringify({
            phase: "build",
            lowUsd,
            highUsd,
            basis: "3 slices x 1 build invocation",
            at: "2026-08-22T00:00:00.000Z",
          })}\n`,
        );
      }
    };
  }

  async function runWith(lowUsd: number, highUsd: number, ceiling: number): Promise<FakeRunner> {
    const runner = new FakeRunner(true, 0, USAGE, estimating(lowUsd, highUsd));
    seed("capture");
    writeBudget("p", ceiling, env);
    await advance("p", runner, env, { verify: PASSES });
    fs.writeFileSync(path.join(env.SFO_HOME, "p", ".sfo", "ANSWERS.json"), '{"answers":[]}');
    await advance("p", runner, env, { verify: PASSES });
    return runner;
  }

  it("refuses before test-write, not after it has been paid for", async () => {
    // The gate used to sit at the start of the build, after test-write had
    // run. On the first real project test-write cost $11.73, unestimated.
    const runner = await runWith(50, 90, 20);

    expect(coveredStages(runner)).toEqual([]);
    const s = readState("p", env);
    expect(s.status).toBe("awaiting_human");
    expect(s.currentStage).toBe("plan");
  });

  it("records the refusal with both numbers, as an external decision", async () => {
    await runWith(50, 90, 20);

    const d = readDecisions("p", env);
    expect(d).toHaveLength(1);
    expect(d[0].decision).toMatch(/ceiling cannot cover/);
    expect(d[0].decision).toMatch(/test-write/);
    expect(d[0].why).toMatch(/\$50/);
    expect(d[0].blast_radius).toBe("external");
    expect(d[0].decided_by).toBe("agent");
  });

  it("builds when only the high end overruns, leaving the slice check to stop it", async () => {
    // The decisive case for the design. A range straddling what is left means
    // the build MIGHT fit, and the per-slice ceiling already stops it at a
    // boundary with the work so far kept — so parking here would trade a
    // graceful stop for an extra interruption on a maybe.
    const runner = await runWith(0.01, 900, 100);

    expect(sliceStages(runner).length).toBeGreaterThan(0);
  });

  it("measures the estimate against what is LEFT, not the whole ceiling", async () => {
    // The front half has spent $0.20 of a $0.70 ceiling, leaving $0.50. A $0.60
    // build fits the ceiling and does not fit the money. Chosen so the estimate
    // falls BETWEEN the two: compared against the ceiling this passes, and the
    // build starts with less than it needs.
    const ceiling = USAGE.costUsd * PRE_ESTIMATE_STAGES + 0.5;
    const runner = await runWith(0.6, 0.9, ceiling);

    expect(coveredStages(runner)).toEqual([]);
    expect(readState("p", env).status).toBe("awaiting_human");
  });

  it("ignores the estimate when no ceiling is set", async () => {
    const runner = new FakeRunner(true, 0, USAGE, estimating(500, 900));
    seed("capture");
    await advance("p", runner, env, { verify: PASSES });
    fs.writeFileSync(path.join(env.SFO_HOME, "p", ".sfo", "ANSWERS.json"), '{"answers":[]}');
    await advance("p", runner, env, { verify: PASSES });

    expect(sliceStages(runner).length).toBeGreaterThan(0);
  });

  it("starts the build once the ceiling is raised to cover it", async () => {
    await runWith(50, 90, 20);
    writeBudget("p", 500, env);

    const resumed = new FakeRunner(true, 0, USAGE, producesArtifacts());
    await advance("p", resumed, env, { verify: PASSES });

    expect(resumed.calls.map((c) => stageOf(c))[0]).toBe("test-write");
    expect(sliceStages(resumed)).toEqual(["build-S-01", "build-S-02", "build-S-03"]);
    expect(readState("p", env).status).toBe("done");
  });
});

describe("the ceiling during a build", () => {
  /**
   * Every stage costs the same, so the ceiling can be aimed at a slice
   * boundary: half a stage past the last stage before the build, which the
   * first slice then overruns. Deliberately not set to an exact multiple —
   * `exceeded` compares floats, and 0.05 seven times is not 0.35.
   */
  const PRE_BUILD_STAGES = 6;

  async function spendToTheCeilingMidBuild(): Promise<FakeRunner> {
    const runner = new FakeRunner(true, 0, USAGE, producesArtifacts());
    seed("capture");
    writeBudget("p", USAGE.costUsd * (PRE_BUILD_STAGES + 0.5), env);
    await advance("p", runner, env, { verify: PASSES });
    fs.writeFileSync(path.join(env.SFO_HOME, "p", ".sfo", "ANSWERS.json"), '{"answers":[]}');
    await advance("p", runner, env, { verify: PASSES });
    return runner;
  }

  it("stops at the slice boundary rather than part-way through the build", async () => {
    const runner = await spendToTheCeilingMidBuild();

    expect(sliceStages(runner)).toEqual(["build-S-01"]);
    const s = readState("p", env);
    expect(s.status).toBe("awaiting_human");
    expect(s.currentStage).toBe("build");
    expect(s.slicesPassed).toEqual(["S-01"]);
  });

  it("records the halt against the slice it refused, with the numbers", async () => {
    await spendToTheCeilingMidBuild();

    const decisions = readDecisions("p", env);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].decision).toContain("build-S-02");
    expect(decisions[0].blast_radius).toBe("external");
  });

  it("resumes at the refused slice once the ceiling is raised, not at the first", async () => {
    await spendToTheCeilingMidBuild();
    writeBudget("p", 100, env);

    const resumed = pipelineRunner();
    await advance("p", resumed, env, { verify: PASSES });

    expect(sliceStages(resumed)).toEqual(["build-S-02", "build-S-03"]);
    expect(readState("p", env).status).toBe("done");
  });
});

describe("what the build refuses to start on", () => {
  it("stops before spending anything when a slice has no test file named for it", async () => {
    // test-write named the suite something the slice ids cannot be found in.
    // Without this check every slice runs against the WHOLE suite, fails on
    // other slices' unimplemented tests, and is retried once — the entire
    // build's cost, with nothing in the output naming the real cause.
    const misnamed = new FakeRunner(true, 0, USAGE, (stage) => {
      // Everything else the pipeline produces is present, so this test fails
      // on the naming alone rather than on a project that was never buildable.
      producesArtifacts(SLICES)(stage);
      if (stage === "test-write") {
        fs.rmSync(path.join(env.SFO_HOME, "p", "tests"), { recursive: true, force: true });
        const dir = path.join(env.SFO_HOME, "p", "tests");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "test_everything.py"), "def test_all(): assert False\n");
      }
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await runPipeline(misnamed, { verify: PASSES });

    expect(sliceStages(misnamed)).toEqual([]);
    expect(readCostRecords("p", env).map((r) => r.stage)).not.toContain("build-S-01");
    const s = readState("p", env);
    expect(s.status).toBe("failed");
    expect(s.currentStage).toBe("build");
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(/no test file under tests\/ is named for S-01, S-02, S-03/),
    );
    expect(error).toHaveBeenCalledWith(expect.stringContaining("test-write"));
    error.mockRestore();
  });

  it("reports every blocker at once, not one per paid run", async () => {
    // The two have different remedies, so reporting only the first costs the
    // user a full run to discover the second.
    const broken = new FakeRunner(true, 0, USAGE, (stage) => {
      producesArtifacts(SLICES, null)(stage);
      if (stage === "test-write") {
        const dir = path.join(env.SFO_HOME, "p", "tests");
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "test_everything.py"), "def test_all(): assert False\n");
      }
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await runPipeline(broken, { verify: PASSES });

    const said = error.mock.calls.map((c) => String(c[0])).join("\n");
    expect(said).toMatch(/no verification recipe/);
    expect(said).toMatch(/no test file under tests\//);
    expect(sliceStages(broken)).toEqual([]);
    error.mockRestore();
  });

  it("builds normally when every slice has a file named for it", async () => {
    const runner = pipelineRunner("cli-python");
    await runPipeline(runner, { verify: PASSES });

    expect(sliceStages(runner)).toEqual(["build-S-01", "build-S-02", "build-S-03"]);
  });

  it("stops before spending anything on an archetype nobody registered", async () => {
    // "cli-rust" has no recipe, so every slice would report "no gates
    // available" and fail twice before anyone learned the stack was the problem.
    const runner = pipelineRunner("cli-rust");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await runPipeline(runner, { verify: PASSES });

    expect(sliceStages(runner)).toEqual([]);
    expect(readState("p", env).status).toBe("failed");
    expect(error).toHaveBeenCalledWith(expect.stringContaining("ARCHETYPE.json"));
    expect(error).toHaveBeenCalledWith(expect.stringContaining("cli-python"));
    error.mockRestore();
  });
});

describe("VERIFY.jsonl", () => {
  it("records every attempt at every slice, passed and failed", async () => {
    await runPipeline(pipelineRunner("cli-python"), { verify: failing("S-01") });

    // S-01 twice and abandoned, S-02 skipped as its dependent, S-03 built.
    expect(readVerifyRecords("p", env).map((r) => [r.slice, r.attempt, r.ok])).toEqual([
      ["S-01", 1, false],
      ["S-01", 2, false],
      ["S-03", 1, true],
    ]);
  });

  it("records the archetype each slice was graded as", async () => {
    await runPipeline(pipelineRunner("cli-python"), { verify: PASSES });

    expect(readVerifyRecords("p", env).every((r) => r.archetype === "cli-python")).toBe(true);
  });

  it("records which step failed, so deliver can say what broke", async () => {
    await runPipeline(pipelineRunner("cli-python"), { verify: STOPS_AT_TEST });

    const first = readVerifyRecords("p", env)[0];
    expect(first.ok).toBe(false);
    expect(first.failedStep).toBe("test");
    expect(first.reason).toBe("test failed");
  });

  it("leaves no failed step on a slice that passed", async () => {
    await runPipeline(pipelineRunner("cli-python"), { verify: PASSES });

    expect(readVerifyRecords("p", env)[0].failedStep).toBeUndefined();
  });

  it("records the test files a build tampered with", async () => {
    // The real gate, and a build agent doing the cheapest thing that makes a
    // failing test pass: editing the test.
    const tamperer = new FakeRunner(true, 0, undefined, (stage) => {
      producesArtifacts()(stage);
      if (stage === "build-S-01") {
        fs.writeFileSync(
          path.join(env.SFO_HOME, "p", "tests", "test_s01.py"),
          "def test_s01(): pass\n",
        );
      }
    });

    await runPipeline(tamperer, {});

    const s01 = readVerifyRecords("p", env).filter((r) => r.slice === "S-01");
    expect(s01).toHaveLength(2);
    expect(s01[0].ok).toBe(false);
    expect(s01[0].tamperedTests).toEqual(["tests/test_s01.py"]);
  });

  it("records a slice whose build agent never finished", async () => {
    await runPipeline(new BuildFailsRunner("cli-python"), { verify: PASSES });

    const records = readVerifyRecords("p", env);
    expect(records[0].ok).toBe(false);
    expect(records[0].reason).toMatch(/build agent exited 1/);
    // Never graded, so nothing may claim a step failed.
    expect(records[0].failedStep).toBeUndefined();
  });

  it("survives the round trip through its own schema", async () => {
    await runPipeline(pipelineRunner("cli-python"), { verify: failing("S-01") });

    // readVerifyRecords validates every line; a record the writer produced that
    // the reader rejects would throw here.
    expect(() => readVerifyRecords("p", env)).not.toThrow();
    expect(readVerifyRecords("p", env).length).toBeGreaterThan(0);
  });
});

/** Hits the plan's usage limit at one stage, the first time only; everything else succeeds. */
class LimitedOnceRunner implements Runner {
  calls: RunStageInput[] = [];
  private hit = false;
  constructor(private readonly at: string) {}
  async runStage(input: RunStageInput): Promise<StageResult> {
    this.calls.push(input);
    const stage = stageOf(input);
    producesArtifacts()(stage);
    if (stage === this.at && !this.hit) {
      this.hit = true;
      return {
        ok: false,
        exitCode: 1,
        logPath: input.logPath,
        usage: USAGE,
        billing: "plan",
        limited: { resetsAt: "2026-09-27T20:00:00.000Z", window: "five_hour" },
      };
    }
    return { ok: true, exitCode: 0, logPath: input.logPath };
  }
}

describe("a subscription's usage limit", () => {
  it("parks at the stage it stopped, without failing it, and says when it resets", async () => {
    seed("capture");
    const runner = new LimitedOnceRunner("research");
    await advance("p", runner, env);

    const s = readState("p", env);
    expect(s.status).toBe("awaiting_human");
    // The last stage finished, so the next run repeats research rather than skipping it.
    expect(s.currentStage).toBe("capture");
    expect(s.attempts.research).toBeUndefined();
    // Spent before the limit, so still on the bill.
    expect(readCostRecords("p", env).find((r) => r.stage === "research")?.billing).toBe("plan");
    expect(formatStatus(listProjects(env))).toMatch(/plan limit reached at research/);
  });

  it("resumes at the stopped stage and clears the note", async () => {
    seed("capture");
    const runner = new LimitedOnceRunner("research");
    await advance("p", runner, env);
    await advance("p", runner, env);

    expect(runner.calls.map(stageOf).filter((st) => st === "research")).toHaveLength(2);
    expect(formatStatus(listProjects(env))).not.toMatch(/plan limit/);
  });

  it("parks mid-build without counting the slice's attempt", async () => {
    const runner = new LimitedOnceRunner("build-S-02");
    await runPipeline(runner, { verify: PASSES });

    const s = readState("p", env);
    expect(s.status).toBe("awaiting_human");
    expect(s.currentStage).toBe("build");
    expect(s.sliceAttempts["S-02"]).toBeUndefined();
    expect(s.slicesFailed).toEqual([]);

    await advance("p", runner, env, { verify: PASSES });
    expect(readState("p", env).slicesPassed).toEqual(["S-01", "S-02", "S-03"]);
  });
});

/**
 * The pipeline, with a build agent that contests one slice's test on its first
 * attempt and an adjudicator whose behaviour each test supplies.
 */
class ContestRunner implements Runner {
  calls: RunStageInput[] = [];
  /** Whether the slice's own unfinished file was visible to the adjudicator. */
  adjudicatorSawWork: boolean[] = [];
  private contested = false;
  constructor(
    private readonly sliceId: string,
    private readonly adjudicator: (dir: string, stage: string) => void,
    private readonly contest: string | null = null,
    /** Contest again on the attempt after the ruling. */
    private readonly again = false,
    /** Which build call of this slice contests, counting from 1. */
    private readonly onCall = 1,
  ) {}
  private buildCalls = 0;
  async runStage(input: RunStageInput): Promise<StageResult> {
    this.calls.push(input);
    const stage = stageOf(input);
    const dir = path.join(env.SFO_HOME, "p");
    producesArtifacts()(stage);
    if (stage === `build-${this.sliceId}`) this.buildCalls++;
    if (
      stage === `build-${this.sliceId}` &&
      this.buildCalls >= this.onCall &&
      (!this.contested || this.again)
    ) {
      const first = !this.contested;
      this.contested = true;
      fs.mkdirSync(path.join(dir, "src"), { recursive: true });
      fs.writeFileSync(path.join(dir, "src", "unfinished.py"), "x = 1\n");
      const body =
        this.contest ??
        JSON.stringify({
          sliceId: this.sliceId,
          criterionId: "AC-001",
          testFile: "tests/test_s01.py",
          testName: "test_s01",
          claim: "unsatisfiable",
          why: first ? "asserts False" : "still wrong",
          proposedFix: "assert the real thing",
        });
      fs.writeFileSync(path.join(dir, ".sfo", "CONTEST.json"), body);
    }
    if (stage.startsWith("adjudicate-")) {
      this.adjudicatorSawWork.push(fs.existsSync(path.join(dir, "src", "unfinished.py")));
      this.adjudicator(dir, stage);
    }
    return { ok: true, exitCode: 0, logPath: input.logPath, usage: USAGE };
  }
}

function ruling(dir: string, body: object): void {
  fs.writeFileSync(path.join(dir, ".sfo", "RULING.json"), JSON.stringify(body));
}

const UPHOLD = (dir: string) => ruling(dir, { ruling: "uphold", why: "the test is right", changedFiles: [], question: null });

const AMEND = (dir: string) => {
  fs.writeFileSync(path.join(dir, "tests", "test_s01.py"), "def test_s01(): assert True\n");
  ruling(dir, { ruling: "amend_test", why: "it asserted False", changedFiles: ["tests/test_s01.py"], question: null });
};

function buildPrompts(runner: ContestRunner, sliceId: string): string[] {
  return runner.calls.filter((c) => stageOf(c) === `build-${sliceId}`).map((c) => c.prompt);
}

describe("contesting a locked test", () => {
  it("offers the contest in the build prompt until it is spent", async () => {
    const runner = new ContestRunner("S-01", UPHOLD);
    await runPipeline(runner, { verify: PASSES });

    const [first, second] = buildPrompts(runner, "S-01");
    expect(first).toContain(".sfo/CONTEST.json");
    expect(second).not.toContain("Write `.sfo/CONTEST.json`");
    expect(second).toContain("Your contest was ruled against");
    expect(second).toContain("the test is right");
  });

  it("skips the gate on a contest and does not count it as an attempt", async () => {
    const graded: string[] = [];
    const verify: VerifyFn = (_id, _a, slice) => {
      graded.push(slice.id);
      return { ok: true, steps: [], tamperedTests: [] };
    };
    const runner = new ContestRunner("S-01", UPHOLD);
    await runPipeline(runner, { verify });

    expect(graded.filter((s) => s === "S-01")).toHaveLength(1);
    expect(readState("p", env).slicesPassed).toContain("S-01");
    const records = readVerifyRecords("p", env).filter((r) => r.slice === "S-01");
    expect(records.map((r) => r.attempt)).toEqual([1]);
  });

  it("sets the slice's unfinished work aside while the adjudicator rules, and restores it", async () => {
    const runner = new ContestRunner("S-01", UPHOLD);
    let restored = false;
    const verify: VerifyFn = (_id, _a, slice) => {
      if (slice.id === "S-01") restored = fs.existsSync(path.join(env.SFO_HOME, "p", "src", "unfinished.py"));
      return { ok: true, steps: [], tamperedTests: [] };
    };
    await runPipeline(runner, { verify });

    expect(runner.adjudicatorSawWork).toEqual([false]);
    expect(restored).toBe(true);
  });

  it("records the ruling as the adjudicator's decision", async () => {
    await runPipeline(new ContestRunner("S-01", UPHOLD), { verify: PASSES });

    const { readContests } = await import("../../src/core/contest.js");
    expect(readContests("p", env)).toMatchObject([{ sliceId: "S-01", ruling: "uphold", status: "ruled" }]);
    const decision = readDecisions("p", env).find((d) => d.id === "D-contest-S-01");
    expect(decision?.decided_by).toBe("adjudicator");
    expect(readCostRecords("p", env).some((r) => r.stage === "adjudicate-S-01")).toBe(true);
  });

  it("amends, relocks, and commits the test without the slice's unfinished work", async () => {
    const lockBefore: Record<string, string> = {};
    const runner = new ContestRunner("S-01", (dir) => {
      Object.assign(lockBefore, readTestLock("p", env));
      AMEND(dir);
    });
    await runPipeline(runner, { verify: PASSES });

    const lock = readTestLock("p", env);
    expect(lock["tests/test_s01.py"]).not.toBe(lockBefore["tests/test_s01.py"]);
    expect(verifyTestLock("p", "tests", env)).toEqual([]);
    const amendCommit = subjects().find((s) => s.startsWith("adjudicate(S-01)"));
    expect(amendCommit).toBeDefined();
    const shown = execFileSync(
      "git",
      ["log", "--name-only", "--format=%s", "--grep=^adjudicate(S-01)"],
      { cwd: path.join(env.SFO_HOME, "p"), encoding: "utf8" },
    );
    expect(shown).toContain("tests/test_s01.py");
    expect(shown).not.toContain("unfinished.py");
    expect(buildPrompts(runner, "S-01")[1]).toContain("Your contest was upheld");
  });

  it("reopens a passed slice the amended suite no longer passes", async () => {
    let amended = false;
    let regraded = 0;
    const runner = new ContestRunner("S-03", (dir) => {
      amended = true;
      fs.writeFileSync(path.join(dir, "tests", "test_s03.py"), "def test_s03(): assert True\n");
      ruling(dir, { ruling: "amend_test", why: "fixture undid itself", changedFiles: [], question: null });
    });
    const verify: VerifyFn = (_id, _a, slice) => {
      if (slice.id === "S-01" && amended && regraded++ === 0) {
        return { ok: false, steps: [], tamperedTests: [], reason: "broken by the amendment" };
      }
      return { ok: true, steps: [], tamperedTests: [] };
    };
    await runPipeline(runner, { verify });

    expect(readVerifyRecords("p", env).some((r) => r.slice === "S-01" && r.trigger === "relock" && !r.ok)).toBe(true);
    // Built a second time after being reopened, and passing again.
    expect(runner.calls.map(stageOf).filter((s) => s === "build-S-01")).toHaveLength(2);
    expect(readState("p", env).slicesPassed).toEqual(expect.arrayContaining(["S-01", "S-02", "S-03"]));
  });

  it("discards a ruling that changed files outside the test tree, and upholds the test", async () => {
    const runner = new ContestRunner("S-01", (dir) => {
      fs.writeFileSync(path.join(dir, "tests", "test_s01.py"), "def test_s01(): assert True\n");
      fs.writeFileSync(path.join(dir, "cheat.py"), "x = 2\n");
      ruling(dir, { ruling: "amend_test", why: "trust me", changedFiles: [], question: null });
    });
    await runPipeline(runner, { verify: PASSES });

    const { readContests } = await import("../../src/core/contest.js");
    const [record] = readContests("p", env);
    expect(record.ruling).toBe("uphold");
    expect(record.rulingWhy).toMatch(/outside the test tree/);
    expect(fs.existsSync(path.join(env.SFO_HOME, "p", "cheat.py"))).toBe(false);
    expect(fs.readFileSync(path.join(env.SFO_HOME, "p", "tests", "test_s01.py"), "utf8")).toContain("assert False");
  });

  it("upholds an amendment whose suite fails the pre-lock check", async () => {
    const runner = new ContestRunner("S-01", AMEND);
    const suiteCheck: SuiteCheckFn = () => ({
      ok: false,
      steps: [{ name: "lint", ok: false, exitCode: 1, output: "E501 line too long" }],
      tamperedTests: [],
    });
    seed("capture");
    await advance("p", runner, env, { verify: PASSES });
    fs.writeFileSync(path.join(env.SFO_HOME, "p", ".sfo", "ANSWERS.json"), '{"answers":[]}');
    // The pre-lock check at test-repair must pass for the build to start at all.
    let calls = 0;
    await advance("p", runner, env, {
      verify: PASSES,
      suiteCheck: (id, e) => (calls++ === 0 ? { ok: true, steps: [], tamperedTests: [] } : suiteCheck(id, e)),
    });

    const { readContests } = await import("../../src/core/contest.js");
    expect(readContests("p", env)[0].rulingWhy).toMatch(/does not pass lint[\s\S]*E501/);
  });

  it("ignores a second contest on the same slice and grades it", async () => {
    const graded: string[] = [];
    const verify: VerifyFn = (_id, _a, slice) => {
      graded.push(slice.id);
      return { ok: true, steps: [], tamperedTests: [] };
    };
    const runner = new ContestRunner("S-01", UPHOLD, null, true);
    await runPipeline(runner, { verify });

    expect(runner.calls.map(stageOf).filter((s) => s.startsWith("adjudicate-"))).toHaveLength(1);
    expect(graded).toContain("S-01");
    expect(fs.existsSync(path.join(env.SFO_HOME, "p", ".sfo", "CONTEST.json"))).toBe(false);
  });

  it("counts an unreadable contest as a failed attempt that says why", async () => {
    const runner = new ContestRunner("S-01", UPHOLD, "{not json");
    await runPipeline(runner, { verify: PASSES });

    const first = readVerifyRecords("p", env).find((r) => r.slice === "S-01");
    expect(first?.ok).toBe(false);
    expect(first?.reason).toMatch(/contest could not be read/);
    expect(runner.calls.some((c) => stageOf(c).startsWith("adjudicate-"))).toBe(false);
  });
});

describe("a criterion the adjudicator finds at fault", () => {
  const DEFECT = (dir: string, stage: string) => {
    if (stage.endsWith("-answer")) {
      const file = path.join(dir, ".sfo", "CRITERIA.jsonl");
      const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      lines[0].text = "one, as the person meant it";
      fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
      fs.writeFileSync(path.join(dir, "tests", "test_s01.py"), "def test_s01(): assert 1\n");
      ruling(dir, { ruling: "amend_test", why: "rewritten", changedFiles: [], question: null });
      return;
    }
    ruling(dir, {
      ruling: "criterion_defect",
      why: "AC-001 contradicts AC-002",
      changedFiles: [],
      question: {
        text: "Which did you mean?",
        context: "They cannot both hold.",
        options: [
          { key: "A", label: "one", tradeoff: "x" },
          { key: "B", label: "two", tradeoff: "y" },
        ],
      },
    });
  };

  it("parks with the question asked, and says so in status", async () => {
    const runner = new ContestRunner("S-01", DEFECT);
    await runPipeline(runner, { verify: PASSES });

    const s = readState("p", env);
    expect(s.status).toBe("awaiting_human");
    expect(s.currentStage).toBe("build");
    const { readQuestions } = await import("../../src/core/questions.js");
    expect(readQuestions("p", env)?.questions.find((q) => q.id === "CQ-S-01")?.section).toBe("blocking");
    expect(formatStatus(listProjects(env))).toMatch(/AC-001 may be wrong \(S-01\)/);
  });

  it("stays parked until answered, then rewrites exactly that criterion and carries on", async () => {
    const runner = new ContestRunner("S-01", DEFECT);
    await runPipeline(runner, { verify: PASSES });
    await advance("p", runner, env, { verify: PASSES });
    expect(runner.calls.filter((c) => stageOf(c).endsWith("-answer"))).toHaveLength(0);

    fs.writeFileSync(
      path.join(env.SFO_HOME, "p", ".sfo", "ANSWERS.json"),
      JSON.stringify({ answers: [{ questionId: "CQ-S-01", answer: "A, the first one", questionText: "Which did you mean?" }] }),
    );
    await advance("p", runner, env, { verify: PASSES });

    const { readCriteria } = await import("../../src/core/criteria.js");
    const criteria = readCriteria("p", env);
    expect(criteria.map((c) => c.text)).toEqual(["one, as the person meant it", "two", "three"]);
    expect(verifyTestLock("p", "tests", env)).toEqual([]);
    const decision = readDecisions("p", env).find((d) => d.id === "D-contest-S-01-answer");
    expect(decision?.decided_by).toBe("human");
    expect(readState("p", env).slicesPassed).toEqual(expect.arrayContaining(["S-01", "S-02", "S-03"]));
  });

  it("does not apply an answer written against different wording of the same question id", async () => {
    // CQ ids are derived from the slice, so an earlier answer to an earlier
    // CQ-S-01 is the case to fear: applying it would rewrite a criterion from
    // a reply to a question the person never saw.
    const runner = new ContestRunner("S-01", DEFECT);
    await runPipeline(runner, { verify: PASSES });
    fs.writeFileSync(
      path.join(env.SFO_HOME, "p", ".sfo", "ANSWERS.json"),
      JSON.stringify({ answers: [{ questionId: "CQ-S-01", answer: "B", questionText: "An older question" }] }),
    );
    await advance("p", runner, env, { verify: PASSES });

    expect(runner.calls.filter((c) => stageOf(c).endsWith("-answer"))).toHaveLength(0);
    expect(readState("p", env).status).toBe("awaiting_human");
  });
});

describe("an amended test and the contested slice's history", () => {
  it("forgets the failures graded against the broken test", async () => {
    // Attempt 1 fails the gate; attempt 2 contests and wins. Without the reset
    // the slice would be one failure from abandonment, charged for the test's defect.
    let s01 = 0;
    const verify: VerifyFn = (_id, _a, slice) =>
      slice.id === "S-01" && s01++ === 0
        ? { ok: false, steps: [], tamperedTests: [], reason: "broken test" }
        : { ok: true, steps: [], tamperedTests: [] };
    const runner = new ContestRunner("S-01", AMEND, null, false, 2);
    let attemptsAtAmend: number | undefined = -1;
    const wrapped: Runner = {
      runStage: async (input) => {
        if (stageOf(input) === "build-S-01" && runner.calls.some((c) => stageOf(c).startsWith("adjudicate-"))) {
          attemptsAtAmend = readState("p", env).sliceAttempts["S-01"];
        }
        return runner.runStage(input);
      },
    };
    await runPipeline(wrapped, { verify });

    expect(attemptsAtAmend).toBeUndefined();
    expect(readState("p", env).slicesPassed).toContain("S-01");
  });
});


describe("the smoke stage in the pipeline", () => {
  const OCR_SEAM = {
    id: "vision-ocr",
    name: "macOS Vision OCR",
    kind: "platform",
    effect: "read_only",
    testMode: null,
    credential: null,
    constraints: [],
    smoke: { checks: ["read known text"], maxCostUsd: 0, async: false },
  };

  it("exercises the listed seams after the build and before review", async () => {
    const base = producesArtifacts();
    const runner = new FakeRunner(true, 0, undefined, (stage) => {
      base(stage);
      if (stage === "spec") {
        fs.writeFileSync(path.join(env.SFO_HOME, "p", ".sfo", "SERVICES.jsonl"), `${JSON.stringify(OCR_SEAM)}\n`);
      }
      if (stage === "test-write") {
        fs.mkdirSync(path.join(env.SFO_HOME, "p", "smoke"), { recursive: true });
        fs.writeFileSync(path.join(env.SFO_HOME, "p", "smoke", "test_smoke_vision_ocr.py"), "def test_ocr(): pass\n");
      }
    });
    const ran: string[] = [];
    const smoke = {
      spawnSeam: async ({ args, env: childEnv }: { args: string[]; env: Record<string, string | undefined> }) => {
        ran.push(args.at(-1) ?? "");
        fs.writeFileSync(
          childEnv.SFO_SMOKE_RESULTS ?? "",
          JSON.stringify({ seam: "vision-ocr", check: "read known text", level: "completed", detail: "read it" }),
        );
        return { exitCode: 0, output: "", timedOut: false };
      },
    };
    seed("capture");
    await advance("p", runner, env, { verify: PASSES, smoke });
    fs.writeFileSync(path.join(env.SFO_HOME, "p", ".sfo", "ANSWERS.json"), '{"answers":[]}');
    await advance("p", runner, env, { verify: PASSES, smoke });

    expect(ran).toEqual(["smoke/test_smoke_vision_ocr.py"]);
    const { readSmokeRecords } = await import("../../src/core/smoke.js");
    expect(readSmokeRecords("p", env).map((r) => r.level)).toEqual(["completed"]);
    const stages = runner.calls.map(stageOf);
    expect(stages.indexOf("review")).toBeGreaterThan(stages.lastIndexOf("build-S-03"));
    expect(subjects().some((s) => s.startsWith("stage(smoke)"))).toBe(true);
    expect(readState("p", env).status).toBe("done");
  });
});

describe("a run that dies mid-stage", () => {
  it("repeats the interrupted stage on resume instead of stepping past it", async () => {
    // currentStage names a stage as soon as it starts, so resuming by
    // "the stage after current" skipped whatever the crash interrupted.
    const killed = new KilledRunner("research", producesArtifacts());
    seed("capture");
    await expect(advance("p", killed, env, { verify: PASSES })).rejects.toThrow(/connection/);
    expect(readState("p", env)).toMatchObject({ currentStage: "research", status: "running", completedStage: null });

    const resumed = pipelineRunner();
    await advance("p", resumed, env, { verify: PASSES });
    expect(resumed.calls.map(stageOf).slice(0, 2)).toEqual(["research", "spec"]);
  });

  it("does not repeat a stage that finished before the run stopped", async () => {
    const runner = pipelineRunner();
    seed("capture");
    await advance("p", runner, env, { verify: PASSES });
    // Parked at clarify: spec finished, and resuming must not run it again.
    expect(readState("p", env).completedStage).toBe("spec");
    fs.writeFileSync(path.join(env.SFO_HOME, "p", ".sfo", "ANSWERS.json"), '{"answers":[]}');
    const resumed = pipelineRunner();
    await advance("p", resumed, env, { verify: PASSES });
    expect(resumed.calls.map(stageOf)[0]).toBe("clarify");
  });
});

describe("what a failed slice leaves in the suite", () => {
  it("is discarded before the build's final commit, so later stages see the locked suite", async () => {
    // The first slice to capture fixtures into tests/ failed as tampering, and
    // the build then committed its 262 files; smoke refused the drifted suite.
    const base = producesArtifacts();
    const runner = new FakeRunner(true, 0, undefined, (stage) => {
      base(stage);
      if (stage === "build-S-03") {
        fs.mkdirSync(path.join(env.SFO_HOME, "p", "tests", "fixtures"), { recursive: true });
        fs.writeFileSync(path.join(env.SFO_HOME, "p", "tests", "fixtures", "captured.json"), "{}");
      }
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await runPipeline(runner, { verify: failing("S-03") });
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/discarded changes to the locked suite.*captured.json/));
    error.mockRestore();

    expect(readState("p", env).slicesFailed).toEqual(["S-03"]);
    expect(fs.existsSync(path.join(env.SFO_HOME, "p", "tests", "fixtures", "captured.json"))).toBe(false);
    expect(verifyTestLock("p", "tests", env)).toEqual([]);
  });
});

describe("a failed stage", () => {
  it("says why in sfo status, not just that it failed", async () => {
    const runner = new FakeRunner(false);
    seed("capture");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await advance("p", runner, env);
    error.mockRestore();
    expect(readState("p", env).status).toBe("failed");
    expect(formatStatus(listProjects(env))).toMatch(/failed at research: the research agent exited 1/);
  });
});

describe("sfo retry after delivery", () => {
  it("re-checks only the failed seam, skips review, delivers again, and clears the retry", async () => {
    const seamRecord = (id: string) => ({
      id,
      name: id,
      kind: "platform",
      effect: "read_only",
      testMode: null,
      credential: null,
      constraints: [],
      smoke: { checks: ["c"], maxCostUsd: 0, async: false },
    });
    const base = producesArtifacts();
    const runner = new FakeRunner(true, 0, undefined, (stage) => {
      base(stage);
      if (stage === "spec") {
        fs.writeFileSync(
          path.join(env.SFO_HOME, "p", ".sfo", "SERVICES.jsonl"),
          `${JSON.stringify(seamRecord("good"))}\n${JSON.stringify(seamRecord("flaky"))}\n`,
        );
      }
      if (stage === "test-write") {
        fs.mkdirSync(path.join(env.SFO_HOME, "p", "smoke"), { recursive: true });
        for (const s of ["good", "flaky"]) fs.writeFileSync(path.join(env.SFO_HOME, "p", "smoke", `test_smoke_${s}.py`), "def test_it(): pass\n");
      }
    });
    let flakyFixed = false;
    const ran: string[] = [];
    const smoke = {
      spawnSeam: async ({ args, env: childEnv }: { args: string[]; env: Record<string, string | undefined> }) => {
        const file = args.at(-1) ?? "";
        ran.push(file);
        const ok = !file.includes("flaky") || flakyFixed;
        fs.writeFileSync(childEnv.SFO_SMOKE_RESULTS ?? "", JSON.stringify({ seam: "x", check: "c", level: ok ? "completed" : "failed", detail: "" }));
        return { exitCode: ok ? 0 : 1, output: "", timedOut: false };
      },
    };
    const failGate = () => ({ ok: false, steps: [], tamperedTests: [], reason: "no" });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    seed("capture");
    await advance("p", runner, env, { verify: PASSES, smoke, passedGate: failGate });
    fs.writeFileSync(path.join(env.SFO_HOME, "p", ".sfo", "ANSWERS.json"), '{"answers":[]}');
    await advance("p", runner, env, { verify: PASSES, smoke, passedGate: failGate });
    expect(readState("p", env).status).toBe("done");

    const { retryFailed } = await import("../../src/commands/retry.js");
    const { readRetry } = await import("../../src/core/retry.js");
    expect(retryFailed("p", env)).toMatch(/seam flaky will be checked again/);

    flakyFixed = true;
    ran.length = 0;
    runner.calls.length = 0;
    await advance("p", runner, env, { verify: PASSES, smoke, passedGate: failGate });
    error.mockRestore();

    expect(ran).toEqual(["smoke/test_smoke_flaky.py"]);
    expect(runner.calls.map(stageOf)).toEqual(["deliver"]);
    expect(readState("p", env).status).toBe("done");
    expect(readRetry("p", env)).toBeNull();
  });
});

describe("a slice that fails again on a retry", () => {
  it("sends its failing test to the adjudicator, and is built again if the test is amended", async () => {
    let amended = false;
    const base = producesArtifacts();
    const runner = new FakeRunner(true, 0, undefined, (stage) => {
      base(stage);
      if (stage === "adjudicate-S-03-retry") {
        amended = true;
        fs.writeFileSync(path.join(env.SFO_HOME, "p", "tests", "test_s03.py"), "def test_s03(): assert 1\n");
        fs.writeFileSync(
          path.join(env.SFO_HOME, "p", ".sfo", "RULING.json"),
          JSON.stringify({ ruling: "amend_test", why: "the helper globbed a .gitignore", changedFiles: [], question: null }),
        );
      }
    });
    const verify: VerifyFn = (_id, _a, slice) =>
      slice.id === "S-03" && !amended
        ? { ok: false, steps: [{ name: "test", ok: false, exitCode: 1, output: "FAILED tests/test_s03.py::test_s03 - ReadError" }], tamperedTests: [] }
        : { ok: true, steps: [], tamperedTests: [] };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await runPipeline(runner, { verify });
    expect(readState("p", env).slicesFailed).toEqual(["S-03"]);

    const { retryFailed } = await import("../../src/commands/retry.js");
    retryFailed("p", env);
    await advance("p", runner, env, { verify });
    error.mockRestore();

    const { readContests } = await import("../../src/core/contest.js");
    expect(readContests("p", env).find((c) => c.sliceId === "S-03-retry")).toMatchObject({ testFile: "tests/test_s03.py", ruling: "amend_test" });
    expect(readState("p", env)).toMatchObject({ slicesFailed: [], status: "done" });
    expect(readState("p", env).slicesPassed).toContain("S-03");
  });
});
