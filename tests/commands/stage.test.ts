import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runSingleStage } from "../../src/commands/stage.js";
import { writeState, readState, type ProjectState } from "../../src/core/state.js";
import { readCostRecords, recordCost } from "../../src/core/cost.js";
import { writeBudget } from "../../src/core/budget.js";
import type { Runner, RunStageInput, StageResult, StageUsage } from "../../src/runner/types.js";

let env: Record<string, string>;

const USAGE: StageUsage = {
  costUsd: 0.07,
  durationMs: 1000,
  numTurns: 1,
  inputTokens: 2,
  outputTokens: 4,
  cacheCreationInputTokens: 10,
  cacheReadInputTokens: 20,
};

class FakeRunner implements Runner {
  constructor(
    private readonly ok = true,
    private readonly usage: StageUsage | undefined = undefined,
  ) {}
  async runStage(input: RunStageInput): Promise<StageResult> {
    return { ok: this.ok, exitCode: this.ok ? 0 : 1, logPath: input.logPath, usage: this.usage };
  }
}

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

function seed(status: ProjectState["status"], currentStage = "research") {
  fs.mkdirSync(path.join(env.SFO_HOME, "p", ".sfo"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: path.join(env.SFO_HOME, "p") });
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

  it("commits a successful re-run, which is what makes the diff exist at all", async () => {
    // `sfo stage` is the debugging tool: re-run one stage and read the diff.
    // Without a commit the previous artifacts are simply overwritten.
    seed("awaiting_human", "clarify");
    await runSingleStage("p", "spec", env, new FakeRunner(true));

    expect(subjects()).toEqual([expect.stringContaining("stage(spec)")]);
  });

  it("does not commit a re-run that failed again", async () => {
    seed("failed");
    await runSingleStage("p", "research", env, new FakeRunner(false));

    expect(subjects()).toEqual([]);
  });

  it("records the cost of a re-run, including one that fails again", async () => {
    seed("failed");
    await runSingleStage("p", "research", env, new FakeRunner(false, USAGE));
    await runSingleStage("p", "research", env, new FakeRunner(true, USAGE));

    const records = readCostRecords("p", env);
    expect(records.map((r) => r.ok)).toEqual([false, true]);
    expect(records).toHaveLength(2);
  });
});

describe("the ceiling warns but does not block the manual escape hatch", () => {
  function overCeiling() {
    seed("awaiting_human");
    writeBudget("p", 1, env);
    recordCost("p", "research", true, { ...USAGE, costUsd: 5 }, env);
  }

  function captureRun(stage: string) {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m) => void lines.push(String(m)));
    return runSingleStage("p", stage, env, new FakeRunner(true, USAGE)).finally(() => {
      spy.mockRestore();
    }).then(() => lines.join("\n"));
  }

  it("warns before spending when the project is over its ceiling", async () => {
    overCeiling();
    const out = await captureRun("spec");

    expect(out).toMatch(/over its ceiling/);
    expect(out).toMatch(/sfo budget p <usd>/);
  });

  it("warns but still runs the stage — it is an override, not a gate", async () => {
    // sfo run refuses over-ceiling projects. This command must not, or the
    // documented recovery path (re-run a stage by hand) dead-ends the moment
    // a ceiling is hit.
    overCeiling();
    await captureRun("spec");

    expect(readCostRecords("p", env).map((r) => r.stage)).toEqual(["research", "spec"]);
  });

  it("says nothing about budget when the project is under its ceiling", async () => {
    seed("awaiting_human");
    writeBudget("p", 100, env);
    recordCost("p", "research", true, { ...USAGE, costUsd: 5 }, env);

    expect(await captureRun("spec")).not.toMatch(/ceiling/);
  });

  it("says nothing about budget when no ceiling is set", async () => {
    seed("awaiting_human");
    recordCost("p", "research", true, { ...USAGE, costUsd: 500 }, env);

    expect(await captureRun("spec")).not.toMatch(/ceiling/);
  });
});
