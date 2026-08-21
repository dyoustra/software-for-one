import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SliceSchema,
  readSlices,
  writeSlices,
  skippedBy,
  nextRunnable,
  uncoveredCriterionIds,
  unknownCriterionIds,
} from "../../src/core/slices.js";

let env: Record<string, string>;

beforeEach(() => {
  env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-sl-")) };
  fs.mkdirSync(path.join(env.SFO_HOME, "p", ".sfo"), { recursive: true });
});

const slices = [
  { id: "S-01", name: "Enumeration", criterionIds: ["AC-001", "AC-002"], prerequisites: [] },
  { id: "S-02", name: "Naming", criterionIds: ["AC-003"], prerequisites: ["S-01"] },
  { id: "S-03", name: "Collisions", criterionIds: ["AC-004"], prerequisites: ["S-02"] },
  { id: "S-04", name: "Sampling", criterionIds: ["AC-005"], prerequisites: [] },
];

describe("slices", () => {
  it("round-trips through disk", () => {
    writeSlices("p", slices, env);
    expect(readSlices("p", env)).toHaveLength(4);
  });

  it("rejects duplicate slice ids", () => {
    expect(() => writeSlices("p", [slices[0], { ...slices[1], id: "S-01" }], env)).toThrow(/duplicate/i);
  });

  it("rejects a prerequisite that names no known slice", () => {
    const orphan = [{ ...slices[0], prerequisites: ["S-99"] }];
    expect(() => writeSlices("p", orphan, env)).toThrow(/unknown prerequisite/i);
  });

  it("rejects a prerequisite cycle", () => {
    const cyclic = [
      { id: "S-01", name: "a", criterionIds: ["AC-001"], prerequisites: ["S-02"] },
      { id: "S-02", name: "b", criterionIds: ["AC-002"], prerequisites: ["S-01"] },
    ];
    expect(() => writeSlices("p", cyclic, env)).toThrow(/cycle/i);
  });

  it("rejects a slice with no criteria — nothing to build or verify", () => {
    expect(() => writeSlices("p", [{ ...slices[0], criterionIds: [] }], env)).toThrow(/no criteria/i);
  });

  it("skips everything downstream of a failed slice, transitively", () => {
    // S-02 depends on S-01, S-03 on S-02. Failing S-01 must skip both, not just
    // its direct dependent — otherwise S-03 burns a build to fail on missing code.
    expect(skippedBy(slices, ["S-01"]).sort()).toEqual(["S-02", "S-03"]);
  });

  it("leaves independent slices runnable when another fails", () => {
    expect(skippedBy(slices, ["S-01"])).not.toContain("S-04");
  });

  it("returns the next slice whose prerequisites have all passed", () => {
    expect(nextRunnable(slices, { passed: ["S-01"], failed: [] })?.id).toBe("S-02");
  });

  it("returns null when every slice is accounted for", () => {
    expect(nextRunnable(slices, { passed: ["S-01", "S-02", "S-03", "S-04"], failed: [] })).toBeNull();
  });
});

describe("validation on read", () => {
  function writeRaw(body: string) {
    fs.writeFileSync(path.join(env.SFO_HOME, "p", ".sfo", "SLICES.jsonl"), body);
  }

  it("rejects a cyclic file written outside writeSlices", () => {
    // The plan stage writes this file directly, so read is the only path that
    // production actually takes. A cycle here stalls the build loop silently.
    writeRaw(
      '{"id":"S-01","name":"a","criterionIds":["AC-001"],"prerequisites":["S-02"]}\n' +
      '{"id":"S-02","name":"b","criterionIds":["AC-002"],"prerequisites":["S-01"]}\n',
    );
    expect(() => readSlices("p", env)).toThrow(/cycle/i);
  });

  it("rejects a dangling prerequisite written outside writeSlices", () => {
    writeRaw('{"id":"S-01","name":"a","criterionIds":["AC-001"],"prerequisites":["S-99"]}\n');
    expect(() => readSlices("p", env)).toThrow(/unknown prerequisite/i);
  });
});

describe("criterion coverage", () => {
  it("finds criteria no slice claims", () => {
    // A criterion in no slice is never built, tested, or reported — it just
    // drops out of the contract.
    expect(uncoveredCriterionIds(slices, ["AC-001", "AC-005", "AC-099"])).toEqual(["AC-099"]);
  });

  it("finds slice criterion ids that match no criterion", () => {
    expect(unknownCriterionIds(slices, ["AC-001", "AC-002", "AC-003", "AC-004"])).toEqual(["AC-005"]);
  });

  it("reports nothing when the two sets line up", () => {
    const ids = ["AC-001", "AC-002", "AC-003", "AC-004", "AC-005"];
    expect(uncoveredCriterionIds(slices, ids)).toEqual([]);
    expect(unknownCriterionIds(slices, ids)).toEqual([]);
  });
});
