import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordCost, readCostRecords, totalCost, type CostRecord } from "../../src/core/cost.js";
import type { StageUsage } from "../../src/runner/types.js";

let env: Record<string, string>;

function usage(over: Partial<StageUsage> = {}): StageUsage {
  return {
    costUsd: 0.1,
    durationMs: 1000,
    numTurns: 1,
    inputTokens: 2,
    outputTokens: 4,
    cacheCreationInputTokens: 100,
    cacheReadInputTokens: 200,
    ...over,
  };
}

function costFile(id: string): string {
  return path.join(env.SFO_HOME, id, ".sfo", "COST.jsonl");
}

beforeEach(() => {
  env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-cost-")) };
});

describe("recordCost", () => {
  it("appends one line per run instead of overwriting", () => {
    // Retries and `sfo stage` re-runs are real spend. Overwriting would report
    // only the successful attempt and under-count the bill.
    recordCost("p", "research", true, usage({ costUsd: 0.1 }), env);
    recordCost("p", "research", false, usage({ costUsd: 0.2 }), env);

    const lines = fs.readFileSync(costFile("p"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => JSON.parse(l).usage.costUsd)).toEqual([0.1, 0.2]);
    expect(lines.map((l) => JSON.parse(l).ok)).toEqual([true, false]);
  });

  it("stamps the stage and an ISO timestamp", () => {
    recordCost("p", "spec", true, usage(), env);
    const rec = readCostRecords("p", env)[0];
    expect(rec.stage).toBe("spec");
    expect(Number.isNaN(Date.parse(rec.at))).toBe(false);
  });

  it("is a no-op when the runner reported no usage", () => {
    recordCost("p", "research", true, undefined, env);
    expect(fs.existsSync(costFile("p"))).toBe(false);
  });
});

describe("readCostRecords", () => {
  it("returns nothing for a project that has never spent", () => {
    expect(readCostRecords("nobody", env)).toEqual([]);
  });

  it("skips corrupt lines rather than throwing", () => {
    // A run killed mid-write can leave a half-line behind; one bad line must
    // not make `sfo cost` unusable for the whole project.
    recordCost("p", "research", true, usage(), env);
    fs.appendFileSync(costFile("p"), '{"stage":"broken"\n');
    recordCost("p", "spec", true, usage(), env);

    expect(readCostRecords("p", env).map((r) => r.stage)).toEqual(["research", "spec"]);
  });

  it("skips JSON lines that are not cost records", () => {
    recordCost("p", "research", true, usage(), env);
    fs.appendFileSync(costFile("p"), '{"hello":"world"}\n');
    expect(readCostRecords("p", env)).toHaveLength(1);
  });
});

describe("totalCost", () => {
  it("sums every numeric field", () => {
    const records: CostRecord[] = [
      { stage: "research", at: "2026-08-21T00:00:00.000Z", ok: true, usage: usage() },
      {
        stage: "spec",
        at: "2026-08-21T00:01:00.000Z",
        ok: false,
        usage: usage({ costUsd: 0.4, numTurns: 3, inputTokens: 8 }),
      },
    ];

    expect(totalCost(records)).toEqual({
      costUsd: 0.5,
      durationMs: 2000,
      numTurns: 4,
      inputTokens: 10,
      outputTokens: 8,
      cacheCreationInputTokens: 200,
      cacheReadInputTokens: 400,
    });
  });

  it("returns zeros for no records", () => {
    expect(totalCost([]).costUsd).toBe(0);
    expect(totalCost([]).inputTokens).toBe(0);
  });
});
