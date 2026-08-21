import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { guardRunnable } from "../../src/commands/run.js";
import { writeState, type ProjectState } from "../../src/core/state.js";

let env: Record<string, string>;

function seed(status: ProjectState["status"], heartbeatAt: string | null = null) {
  fs.mkdirSync(path.join(env.SFO_HOME, "p", ".sfo"), { recursive: true });
  writeState(
    {
      id: "p",
      title: "T",
      currentStage: "research",
      status,
      attempts: {},
      pid: status === "running" ? 4321 : null,
      heartbeatAt,
      createdAt: "2026-08-21T00:00:00.000Z",
      updatedAt: "2026-08-21T00:00:00.000Z",
    },
    env,
  );
}

beforeEach(() => {
  env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-run-")) };
});

describe("guardRunnable", () => {
  it("allows a project waiting on a human", () => {
    seed("awaiting_human");
    expect(() => guardRunnable("p", env)).not.toThrow();
  });

  it("refuses a failed project instead of letting the detached child die silently", () => {
    // The detached child runs with stdio: "ignore", so a throw inside it is
    // discarded after the parent already printed "started (pid N)".
    seed("failed");
    expect(() => guardRunnable("p", env)).toThrow(/failed at stage "research"/);
  });

  it("refuses a project that is genuinely still running", () => {
    seed("running", new Date().toISOString());
    expect(() => guardRunnable("p", env)).toThrow(/already running/);
  });

  it("allows a running project whose heartbeat went stale", () => {
    seed("running", "2020-01-01T00:00:00.000Z");
    expect(() => guardRunnable("p", env)).not.toThrow();
  });
});
