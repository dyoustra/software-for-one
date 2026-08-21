import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EstimateSchema, readEstimate, writeEstimate, formatEstimate } from "../../src/core/estimate.js";

let env: Record<string, string>;

beforeEach(() => {
  env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-est-")) };
  fs.mkdirSync(path.join(env.SFO_HOME, "p", ".sfo"), { recursive: true });
});

const estimate = {
  phase: "front" as const,
  lowUsd: 3,
  highUsd: 6,
  basis: "Single-purpose CLI; research will need a few searches.",
  at: "2026-08-21T18:00:00.000Z",
};

describe("estimate", () => {
  it("round-trips through disk", () => {
    writeEstimate("p", estimate, env);
    expect(readEstimate("p", env)[0].lowUsd).toBe(3);
  });

  it("appends rather than replacing, so both estimates survive", () => {
    writeEstimate("p", estimate, env);
    writeEstimate("p", { ...estimate, phase: "build", lowUsd: 20, highUsd: 40 }, env);
    expect(readEstimate("p", env)).toHaveLength(2);
  });

  it("rejects a range where low exceeds high", () => {
    expect(EstimateSchema.safeParse({ ...estimate, lowUsd: 10, highUsd: 2 }).success).toBe(false);
  });

  it("formats a range with its basis", () => {
    const out = formatEstimate(estimate);
    expect(out).toContain("$3");
    expect(out).toContain("$6");
    expect(out).toContain("Single-purpose CLI");
  });
});
