import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeState, readState, isStale, type ProjectState } from "../../src/core/state.js";

let home: string;
let env: Record<string, string>;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "sfo-"));
  env = { SFO_HOME: home };
});

function sample(): ProjectState {
  return {
    id: "test-abc123",
    title: "Test idea",
    currentStage: "capture",
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
}

describe("state", () => {
  it("round-trips through disk", () => {
    fs.mkdirSync(path.join(home, "test-abc123", ".sfo"), { recursive: true });
    writeState(sample(), env);
    expect(readState("test-abc123", env).title).toBe("Test idea");
  });

  it("leaves no temp file behind", () => {
    fs.mkdirSync(path.join(home, "test-abc123", ".sfo"), { recursive: true });
    writeState(sample(), env);
    const files = fs.readdirSync(path.join(home, "test-abc123", ".sfo"));
    expect(files).toEqual(["state.json"]);
  });

  it("rejects a malformed state file", () => {
    fs.mkdirSync(path.join(home, "bad", ".sfo"), { recursive: true });
    fs.writeFileSync(path.join(home, "bad", ".sfo", "state.json"), '{"id":1}');
    expect(() => readState("bad", env)).toThrow(/invalid state/i);
  });

  it("treats a running project with an old heartbeat as stale", () => {
    const s = { ...sample(), status: "running" as const, pid: 999999, heartbeatAt: "2020-01-01T00:00:00.000Z" };
    expect(isStale(s, new Date("2026-08-21T00:00:00.000Z"))).toBe(true);
  });

  it("does not call a fresh heartbeat stale", () => {
    const s = { ...sample(), status: "running" as const, pid: 999999, heartbeatAt: "2026-08-21T00:00:00.000Z" };
    expect(isStale(s, new Date("2026-08-21T00:00:30.000Z"))).toBe(false);
  });

  it("never calls a non-running project stale", () => {
    expect(isStale(sample(), new Date("2030-01-01T00:00:00.000Z"))).toBe(false);
  });
});
