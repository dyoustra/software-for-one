import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listProjects, formatStatus } from "../../src/commands/status.js";
import { writeState } from "../../src/core/state.js";

let env: Record<string, string>;

function seed(id: string, stage: string, status: "running" | "awaiting_human" | "failed" | "done") {
  fs.mkdirSync(path.join(env.SFO_HOME, id, ".sfo"), { recursive: true });
  writeState(
    {
      id,
      title: id,
      currentStage: stage,
      status,
      attempts: {},
      pid: null,
      heartbeatAt: null,
      createdAt: "2026-08-21T00:00:00.000Z",
      updatedAt: "2026-08-21T00:00:00.000Z",
    },
    env,
  );
}

beforeEach(() => {
  env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-st-")) };
});

describe("listProjects", () => {
  it("returns an empty list when nothing exists", () => {
    expect(listProjects(env)).toEqual([]);
  });

  it("lists every project", () => {
    seed("a-111", "spec", "running");
    seed("b-222", "clarify", "awaiting_human");
    expect(listProjects(env).map((p) => p.id).sort()).toEqual(["a-111", "b-222"]);
  });

  it("skips directories with no state file", () => {
    seed("a-111", "spec", "running");
    fs.mkdirSync(path.join(env.SFO_HOME, "junk"), { recursive: true });
    expect(listProjects(env)).toHaveLength(1);
  });
});

describe("formatStatus", () => {
  it("flags a project that needs the human", () => {
    seed("b-222", "clarify", "awaiting_human");
    expect(formatStatus(listProjects(env))).toContain("needs you");
  });

  it("reports a stale running project rather than claiming it is live", () => {
    seed("c-333", "spec", "running");
    expect(formatStatus(listProjects(env))).toContain("stale");
  });
});
