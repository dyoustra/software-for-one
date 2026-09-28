import { describe, it, expect } from "vitest";
import { ContestSchema } from "../../src/core/contest.js";

describe("ContestSchema", () => {
  it("accepts a contest with no proposed fix or test name, which cost a real slice an attempt", () => {
    const parsed = ContestSchema.parse({
      sliceId: "S-13",
      criterionId: "AC-102",
      testFile: "tests/test_s13.py",
      testName: null,
      claim: "unsatisfiable",
      why: "the corpus cannot be added under the lock",
      proposedFix: null,
    });
    expect(parsed.proposedFix).toBe("");
    expect(parsed.testName).toBe("");
  });

  it("still needs the claim and why, which are the contest", () => {
    expect(ContestSchema.safeParse({ sliceId: "S-1", criterionId: "A", testFile: "t", claim: "unsatisfiable", why: "" }).success).toBe(false);
  });
});
