import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { advance } from "../../src/core/orchestrator.js";
import { writeState, readState, type ProjectState } from "../../src/core/state.js";
import type { Runner, RunStageInput, StageResult } from "../../src/runner/types.js";

let env: Record<string, string>;

class FakeRunner implements Runner {
  calls: RunStageInput[] = [];
  constructor(
    private readonly ok = true,
    private readonly delayMs = 0,
  ) {}
  async runStage(input: RunStageInput): Promise<StageResult> {
    this.calls.push(input);
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    return { ok: this.ok, exitCode: this.ok ? 0 : 1, logPath: input.logPath };
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

  it("runs the clarify stage once the human has answered", async () => {
    seed("spec");
    fs.writeFileSync(path.join(env.SFO_HOME, "p", ".sfo", "ANSWERS.md"), "# Answers");
    const runner = new FakeRunner();
    await advance("p", runner, env);

    expect(runner.calls.map((c) => path.basename(c.logPath))).toEqual(["clarify.log"]);
    expect(readState("p", env).status).toBe("done");
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

  it("refuses to advance a project that is already done", async () => {
    seed("clarify");
    const s = readState("p", env);
    writeState({ ...s, status: "done" }, env);
    const runner = new FakeRunner();
    await advance("p", runner, env);
    expect(runner.calls).toHaveLength(0);
  });
});
