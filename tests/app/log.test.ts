import { describe, it, expect } from "vitest";
import type { LogEvent } from "../../src/api/types.js";
import { groupCount, shownCommand, stageName, toRows } from "../../app/src/lib/log.js";

describe("activity rows", () => {
  it("marks each command with how it went, and shows a failure's first line", () => {
    const events: LogEvent[] = [
      { kind: "run", target: "pytest -q", id: "a" },
      { kind: "result", id: "a", ok: false, text: "1 failed" },
      { kind: "run", target: "pytest -q", id: "b" },
      { kind: "result", id: "b", ok: true },
    ];
    expect(toRows(events)).toEqual([
      { key: "0", kind: "action", action: "run", verb: "Running", target: "pytest -q", status: "failed", error: "1 failed" },
      { key: "2", kind: "action", action: "run", verb: "Running", target: "pytest -q", status: "ok" },
    ]);
  });

  it("folds a run of reads into one row, and starts a new one after anything else", () => {
    const rows = toRows([
      { kind: "read", target: "SPEC.md", id: "1" },
      { kind: "read", target: "CRITERIA.jsonl", id: "2" },
      { kind: "read", target: "SLICES.jsonl", id: "3" },
      { kind: "edit", target: "src/roll.py", id: "4" },
      { kind: "read", target: "src/roll.py", id: "5" },
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["group", "action", "action"]);
    const group = rows[0] as Extract<(typeof rows)[number], { kind: "group" }>;
    expect(group.targets).toEqual(["SPEC.md", "CRITERIA.jsonl", "SLICES.jsonl"]);
    expect(groupCount(group)).toBe("3 files");
  });

  it("never folds a failed read into a group, so its error stays visible", () => {
    const rows = toRows([
      { kind: "read", target: "a", id: "1" },
      { kind: "read", target: "missing", id: "2" },
      { kind: "result", id: "2", ok: false, text: "no such file" },
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["action", "action"]);
    expect(rows[1]).toMatchObject({ status: "failed", error: "no such file" });
  });

  it("turns a stage's start and finish into dividers, with what it cost", () => {
    const rows = toRows([
      { kind: "start", text: "claude-sonnet-5-5" },
      { kind: "say", text: "Done." },
      { kind: "finish", ok: true, costUsd: 0.0981, durationMs: 19_201 },
    ]);
    expect(rows).toEqual([
      { key: "0", kind: "divider", text: "Started on claude-sonnet-5-5" },
      { key: "1", kind: "say", text: "Done." },
      { key: "2", kind: "divider", text: "Finished   $0.10   19s", failed: false },
    ]);
  });

  it("tells a usage warning from a usage limit", () => {
    expect(toRows([{ kind: "limit", text: "allowed_warning (seven_day)" }])[0]).toMatchObject({ tone: "waiting", text: "Nearing a usage limit (seven_day)" });
    expect(toRows([{ kind: "limit", text: "rejected (five_hour)" }])[0]).toMatchObject({ tone: "failed" });
  });
});

describe("commands", () => {
  it("drop the cd into the project that starts most of them", () => {
    expect(shownCommand("cd /home/sprite/.sfo/dice-roller-cli-6954a7 && uv run pytest -q")).toBe("uv run pytest -q");
    expect(shownCommand('cd "/a b" ; ls')).toBe("ls");
    expect(shownCommand("pytest -q")).toBe("pytest -q");
  });
});

describe("stage names", () => {
  it("read as people would say them", () => {
    expect(["research", "test-write", "build-S-02", "deliver", "something-new"].map(stageName)).toEqual(["Research", "Writing tests", "Build · S-02", "Deliver", "Something new"]);
  });
});
