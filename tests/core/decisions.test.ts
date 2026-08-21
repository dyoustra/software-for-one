import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DecisionSchema, appendDecision, readDecisions } from "../../src/core/decisions.js";

let env: Record<string, string>;

beforeEach(() => {
  env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-dec-")) };
  fs.mkdirSync(path.join(env.SFO_HOME, "p", ".sfo"), { recursive: true });
});

const decision = {
  id: "D-001",
  decision: "App-first slugs",
  chose: "leading segment is the application",
  considered: "subject-first; verbose descriptive names",
  why: "overrides the previous default; follows from the search question being settled",
  decided_by: "human" as const,
  blast_radius: "structural" as const,
  at: "2026-08-21T18:00:00.000Z",
};

describe("decisions", () => {
  it("appends rather than replacing", () => {
    appendDecision("p", decision, env);
    appendDecision("p", { ...decision, id: "D-002", decided_by: "agent" }, env);
    expect(readDecisions("p", env).map((d) => d.id)).toEqual(["D-001", "D-002"]);
  });

  it("requires decided_by — absence must never carry meaning", () => {
    const { decided_by: _omitted, ...without } = decision;
    expect(DecisionSchema.safeParse(without).success).toBe(false);
  });

  it("accepts only the three blast radius values", () => {
    expect(DecisionSchema.safeParse({ ...decision, blast_radius: "medium" }).success).toBe(false);
    for (const r of ["local", "structural", "external"]) {
      expect(DecisionSchema.safeParse({ ...decision, blast_radius: r }).success).toBe(true);
    }
  });

  it("accepts only agent or human as a decider", () => {
    expect(DecisionSchema.safeParse({ ...decision, decided_by: "someone" }).success).toBe(false);
  });

  it("returns an empty list for a project with no decisions", () => {
    expect(readDecisions("p", env)).toEqual([]);
  });
});

describe("timestamp validation", () => {
  it("rejects an unparseable at value", () => {
    expect(DecisionSchema.safeParse({ ...decision, at: "sometime tuesday" }).success).toBe(false);
  });

  it("accepts an ISO timestamp", () => {
    expect(DecisionSchema.safeParse({ ...decision, at: "2026-08-21T18:00:00.000Z" }).success).toBe(true);
  });
});
