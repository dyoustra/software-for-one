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
  constructor(private readonly ok = true) {}
  async runStage(input: RunStageInput): Promise<StageResult> {
    this.calls.push(input);
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

  it("refuses to advance a project that is already done", async () => {
    seed("clarify");
    const s = readState("p", env);
    writeState({ ...s, status: "done" }, env);
    const runner = new FakeRunner();
    await advance("p", runner, env);
    expect(runner.calls).toHaveLength(0);
  });
});
