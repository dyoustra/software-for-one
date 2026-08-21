import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { advance } from "../../src/core/orchestrator.js";
import { writeState, readState, type ProjectState } from "../../src/core/state.js";
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
  ) {}
  async runStage(input: RunStageInput): Promise<StageResult> {
    this.calls.push(input);
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
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
  writeState(s, env);
  return s;
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
    fs.writeFileSync(path.join(env.SFO_HOME, "p", ".sfo", "ANSWERS.md"), "# Answers");

    const resumed = new FakeRunner();
    await advance("p", resumed, env);

    expect(resumed.calls.map((c) => path.basename(c.logPath))).toEqual(["clarify.log"]);
    expect(readState("p", env).status).toBe("done");
  });

  it("does not run clarify twice when advanced again after it completed", async () => {
    seed("capture");
    await advance("p", new FakeRunner(), env);
    fs.writeFileSync(path.join(env.SFO_HOME, "p", ".sfo", "ANSWERS.md"), "# Answers");
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

  it("refuses to advance a project that is already done", async () => {
    seed("clarify");
    const s = readState("p", env);
    writeState({ ...s, status: "done" }, env);
    const runner = new FakeRunner();
    await advance("p", runner, env);
    expect(runner.calls).toHaveLength(0);
  });
});
