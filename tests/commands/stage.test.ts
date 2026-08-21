import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSingleStage } from "../../src/commands/stage.js";
import { writeState, readState, type ProjectState } from "../../src/core/state.js";
import type { Runner, RunStageInput, StageResult } from "../../src/runner/types.js";

let env: Record<string, string>;

class FakeRunner implements Runner {
  constructor(private readonly ok = true) {}
  async runStage(input: RunStageInput): Promise<StageResult> {
    return { ok: this.ok, exitCode: this.ok ? 0 : 1, logPath: input.logPath };
  }
}

function seed(status: ProjectState["status"], currentStage = "research") {
  fs.mkdirSync(path.join(env.SFO_HOME, "p", ".sfo"), { recursive: true });
  writeState(
    {
      id: "p",
      title: "T",
      currentStage,
      status,
      attempts: { research: 1 },
      pid: null,
      heartbeatAt: null,
      createdAt: "2026-08-21T00:00:00.000Z",
      updatedAt: "2026-08-21T00:00:00.000Z",
    },
    env,
  );
}

beforeEach(() => {
  env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-stage-")) };
});

describe("runSingleStage", () => {
  it("clears a failed status on success so `sfo run` can continue", async () => {
    // advance() refuses failed projects and its message sends the user here,
    // so this command has to be able to actually clear the block.
    seed("failed");
    await runSingleStage("p", "research", env, new FakeRunner(true));

    const after = readState("p", env);
    expect(after.status).toBe("awaiting_human");
    expect(after.currentStage).toBe("research");
  });

  it("leaves a failed status alone when the re-run also fails", async () => {
    seed("failed");
    await runSingleStage("p", "research", env, new FakeRunner(false));
    expect(readState("p", env).status).toBe("failed");
  });

  it("does not disturb the status of a healthy project", async () => {
    seed("awaiting_human", "clarify");
    await runSingleStage("p", "spec", env, new FakeRunner(true));

    const after = readState("p", env);
    expect(after.status).toBe("awaiting_human");
    expect(after.currentStage).toBe("clarify");
  });
});
