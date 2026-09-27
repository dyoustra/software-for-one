import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readBudget, writeBudget, budgetState } from "../../src/core/budget.js";
import { recordCost } from "../../src/core/cost.js";

let env: Record<string, string>;

const usage = {
  costUsd: 4, durationMs: 1000, numTurns: 1,
  inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
};

beforeEach(() => {
  env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-bud-")) };
  fs.mkdirSync(path.join(env.SFO_HOME, "p", ".sfo"), { recursive: true });
});

describe("budget", () => {
  it("returns null when no ceiling is set", () => {
    expect(readBudget("p", env)).toBeNull();
  });

  it("round-trips a ceiling", () => {
    writeBudget("p", 25, env);
    expect(readBudget("p", env)).toBe(25);
  });

  it("rejects a non-positive ceiling", () => {
    expect(() => writeBudget("p", 0, env)).toThrow(/positive/i);
  });

  it("reports remaining spend against actual cost", () => {
    writeBudget("p", 10, env);
    recordCost("p", "research", true, usage, env);
    const state = budgetState("p", env);
    expect(state?.spent).toBe(4);
    expect(state?.remaining).toBe(6);
    expect(state?.exceeded).toBe(false);
  });

  it("reports exceeded once spend reaches the ceiling", () => {
    writeBudget("p", 7, env);
    recordCost("p", "research", true, usage, env);
    recordCost("p", "spec", true, usage, env);
    expect(budgetState("p", env)?.exceeded).toBe(true);
  });

  it("counts failed stages against the budget", () => {
    // A failed stage spent real money. Excluding it would let a project with
    // repeated failures run past its ceiling indefinitely.
    writeBudget("p", 7, env);
    recordCost("p", "research", false, usage, env);
    recordCost("p", "research", true, usage, env);
    expect(budgetState("p", env)?.exceeded).toBe(true);
  });

  it("returns null state when no ceiling is set, whatever the spend", () => {
    recordCost("p", "research", true, usage, env);
    expect(budgetState("p", env)).toBeNull();
  });

  it("names the file when BUDGET.json is malformed", () => {
    // A raw JSON.parse message ("Unexpected token }") tells the user nothing
    // about which file to go fix. Both gates throw on this, so nothing is
    // spent — but the message is the only thing they get.
    writeBudget("p", 10, env);
    fs.writeFileSync(path.join(env.SFO_HOME, "p", ".sfo", "BUDGET.json"), "{ nope");
    expect(() => readBudget("p", env)).toThrow(/BUDGET\.json is not valid JSON/);
  });

  it("counts plan usage by default, and only billed or unlabeled spend when billed-only", () => {
    recordCost("p", "spec", true, usage, env, "cli", "plan");
    recordCost("p", "triage", true, usage, env, "sdk", "api");
    recordCost("p", "old", true, usage, env);

    writeBudget("p", 100, env);
    expect(budgetState("p", env)?.spent).toBe(12);

    // Unlabeled records count: nobody knows they were free.
    writeBudget("p", 100, env, true);
    const billed = budgetState("p", env);
    expect(billed?.spent).toBe(8);
    expect(billed?.billedOnly).toBe(true);
    expect(readBudget("p", env)).toBe(100);
  });
});
