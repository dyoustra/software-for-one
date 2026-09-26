import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseBudget, setBudget, showBudget } from "../../src/commands/budget.js";
import { createProject } from "../../src/commands/new.js";
import { readBudget } from "../../src/core/budget.js";
import { recordCost } from "../../src/core/cost.js";

let env: Record<string, string>;

const triageOk = vi.fn().mockResolvedValue({
  result: {
    verdict: "ready",
    title: "Subway Tracker",
    reason: "clear",
    counterOffer: null,
    estimateLowUsd: 3,
    estimateHighUsd: 6,
    estimateBasis: "Single-purpose CLI.",
  },
  usage: undefined,
  via: "cli",
});

async function newProject(): Promise<string> {
  return createProject("track my train", triageOk, "abc123", env);
}

beforeEach(() => {
  env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-budcmd-")) };
});

describe("parseBudget", () => {
  it("accepts a positive amount", () => {
    expect(parseBudget("12.5")).toBe(12.5);
  });

  it("rejects a non-number, rather than writing a ceiling of NaN", () => {
    expect(() => parseBudget("lots")).toThrow(/positive dollar amount/);
  });

  it("rejects zero and negatives", () => {
    expect(() => parseBudget("0")).toThrow(/positive/);
    expect(() => parseBudget("-4")).toThrow(/positive/);
  });
});

describe("setBudget", () => {
  it("raises the ceiling on a real project — the way out of a budget park", async () => {
    const id = await newProject();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    setBudget(id, "40", env);

    expect(readBudget(id, env)).toBe(40);
    log.mockRestore();
  });

  it("removes the ceiling with `none`, so the project runs unbounded", async () => {
    const id = await newProject();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    setBudget(id, "40", env);
    setBudget(id, "none", env);

    expect(readBudget(id, env)).toBeNull();
    expect(log).toHaveBeenLastCalledWith(`ceiling removed for ${id}`);
    log.mockRestore();
  });

  it("says so when there was no ceiling to remove", async () => {
    const id = await newProject();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    setBudget(id, "none", env);

    expect(log).toHaveBeenLastCalledWith(`${id} had no ceiling`);
    log.mockRestore();
  });

  it("reports an unknown project instead of creating a stray ceiling", () => {
    expect(() => setBudget("nope", "40", env)).toThrow(/no such project/);
    expect(fs.existsSync(path.join(env.SFO_HOME, "nope"))).toBe(false);
  });
});

describe("showBudget", () => {
  it("shows spend against the ceiling", async () => {
    const id = await newProject();
    setBudget(id, "10", env);
    recordCost(id, "research", true, {
      costUsd: 4, durationMs: 1, numTurns: 1,
      inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
    }, env);

    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((m) => void lines.push(String(m)));
    showBudget(id, env);
    log.mockRestore();

    expect(lines.at(-1)).toContain("$4.00 spent of a $10.00 ceiling");
    expect(lines.at(-1)).toContain("$6.00 left");
  });

  it("says so when there is no ceiling", async () => {
    const id = await newProject();
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((m) => void lines.push(String(m)));
    showBudget(id, env);
    log.mockRestore();

    expect(lines.at(-1)).toMatch(/no ceiling set/);
  });
});
