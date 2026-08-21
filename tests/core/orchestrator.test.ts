import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { advance } from "../../src/core/orchestrator.js";
import { writeState, readState, type ProjectState } from "../../src/core/state.js";
import { writeCriteria } from "../../src/core/criteria.js";
import { readCostRecords } from "../../src/core/cost.js";
import type { Runner, RunStageInput, StageResult, StageUsage } from "../../src/runner/types.js";

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
    private readonly onRun?: () => void,
  ) {}
  async runStage(input: RunStageInput): Promise<StageResult> {
    this.calls.push(input);
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    this.onRun?.();
    return {
      ok: this.ok,
      exitCode: this.ok ? 0 : 1,
      logPath: input.logPath,
      usage: this.usage,
    };
  }
}

function seed(stage: string): ProjectState {
  const s: ProjectState = {
    id: "p",
    title: "T",
    currentStage: stage,
    status: "awaiting_human",
    attempts: {},
    pid: null,
    heartbeatAt: null,
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
  };
  fs.mkdirSync(path.join(env.SFO_HOME, "p", ".sfo"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: path.join(env.SFO_HOME, "p") });
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
    const first = new FakeRunner();
    await advance("p", first, env);

    expect(first.calls.map((c) => path.basename(c.logPath))).toEqual([
      "research.log",
      "spec.log",
    ]);
    expect(readState("p", env).currentStage).toBe("clarify");
    expect(readState("p", env).status).toBe("awaiting_human");

    // The human answers.
    fs.writeFileSync(path.join(env.SFO_HOME, "p", ".sfo", "ANSWERS.json"), '{"answers":[]}');

    const resumed = new FakeRunner();
    await advance("p", resumed, env);

    expect(resumed.calls.map((c) => path.basename(c.logPath))).toEqual(["clarify.log"]);
    expect(readState("p", env).status).toBe("done");
  });

  it("does not run clarify twice when advanced again after it completed", async () => {
    seed("capture");
    await advance("p", new FakeRunner(), env);
    fs.writeFileSync(path.join(env.SFO_HOME, "p", ".sfo", "ANSWERS.json"), '{"answers":[]}');
    await advance("p", new FakeRunner(), env);
    expect(readState("p", env).status).toBe("done");

    const again = new FakeRunner();
    await advance("p", again, env);
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

  it("refuses to advance a project that is already done", async () => {
    seed("clarify");
    const s = readState("p", env);
    writeState({ ...s, status: "done" }, env);
    const runner = new FakeRunner();
    await advance("p", runner, env);
    expect(runner.calls).toHaveLength(0);
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
