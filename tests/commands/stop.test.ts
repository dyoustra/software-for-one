import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stopRun } from "../../src/commands/stop.js";
import { localHost } from "../../src/core/host.js";
import { notifyOutcome } from "../../src/commands/run.js";
import { writeState, readState, type ProjectStateInput } from "../../src/core/state.js";
import { isStopped } from "../../src/core/stopped.js";
import { listProjects, formatStatus } from "../../src/commands/status.js";
import { advance } from "../../src/core/orchestrator.js";

let env: Record<string, string>;

function seed(over: Partial<ProjectStateInput> = {}): void {
  fs.mkdirSync(path.join(env.SFO_HOME, "p", ".sfo"), { recursive: true });
  writeState(
    {
      id: "p",
      title: "Screenshot renamer",
      currentStage: "build",
      status: "running",
      attempts: {},
      pid: 4242,
      heartbeatAt: new Date().toISOString(),
      createdAt: "2026-09-27T00:00:00.000Z",
      updatedAt: "2026-09-27T00:00:00.000Z",
      ...over,
    },
    env,
  );
}

beforeEach(() => {
  env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-stop-")) };
});

describe("stopRun", () => {
  it("signals the run's process group, and leaves it resumable", () => {
    seed();
    const signalled: number[] = [];
    const out = stopRun("p", env, localHost((pid) => void signalled.push(pid)));

    expect(signalled).toEqual([-4242]);
    expect(readState("p", env)).toMatchObject({ status: "awaiting_human", pid: null, currentStage: "build" });
    expect(isStopped("p", env)).toBe(true);
    expect(out).toMatch(/stopped p during build — `sfo run p` resumes it/);
    expect(formatStatus(listProjects(env))).toMatch(/stopped by you/);
  });

  it("falls back to the process itself when it leads no group", () => {
    seed();
    const signalled: number[] = [];
    stopRun("p", env, localHost((pid) => {
      if (pid < 0) throw new Error("ESRCH");
      signalled.push(pid);
    }));
    expect(signalled).toEqual([4242]);
  });

  it("marks it stopped even when the process is already gone", () => {
    seed();
    const out = stopRun("p", env, localHost(() => {
      throw new Error("ESRCH");
    }));
    expect(out).toMatch(/already gone/);
    expect(readState("p", env).status).toBe("awaiting_human");
  });

  it("refuses a project that is not running", () => {
    seed({ status: "done", pid: null });
    expect(() => stopRun("p", env, localHost(() => {}))).toThrow(/not running \(done\)/);
  });

  it("clears the stopped note when the next run starts", async () => {
    seed({ status: "awaiting_human", currentStage: "deliver", pid: null });
    fs.writeFileSync(path.join(env.SFO_HOME, "p", ".sfo", "STOPPED.json"), "{}");
    await advance("p", { runStage: async () => ({ ok: true, exitCode: 0, logPath: "" }) }, env);
    expect(isStopped("p", env)).toBe(false);
  });
});

describe("notifyOutcome", () => {
  const capture = () => {
    const sent: [string, string][] = [];
    return { sent, notify: (t: string, m: string) => void sent.push([t, m]) };
  };

  it("says done, and names the project", () => {
    seed({ status: "done", currentStage: "deliver", pid: null });
    const { sent, notify } = capture();
    notifyOutcome("p", env, notify);
    expect(sent).toEqual([["sfo: Screenshot renamer", "done — SUMMARY.md is ready"]]);
  });

  it("carries the status note when there is one", () => {
    seed({ status: "done", currentStage: "deliver", pid: null });
    fs.writeFileSync(
      path.join(env.SFO_HOME, "p", ".sfo", "SMOKE.jsonl"),
      JSON.stringify({ seam: "anthropic-batch", check: "c", level: "failed", detail: "", attempt: 1, at: "2026-09-27T00:00:00.000Z" }) + "\n",
    );
    const { sent, notify } = capture();
    notifyOutcome("p", env, notify);
    expect(sent[0][1]).toBe("done, but failed against the real thing: anthropic-batch → `sfo retry p` retries what failed");
  });

  it("says a human is needed, and how to answer", () => {
    seed({ status: "awaiting_human", currentStage: "spec", pid: null });
    const { sent, notify } = capture();
    notifyOutcome("p", env, notify);
    expect(sent[0][1]).toBe("needs you — `sfo answer p`");
  });

  it("says where it failed and how to recover", () => {
    seed({ status: "failed", currentStage: "research", pid: null });
    const { sent, notify } = capture();
    notifyOutcome("p", env, notify);
    expect(sent[0][1]).toMatch(/^failed at research — /);
  });
});
