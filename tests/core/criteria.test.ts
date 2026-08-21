import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CriterionSchema, readCriteria, writeCriteria, groupCriteria } from "../../src/core/criteria.js";

let env: Record<string, string>;

beforeEach(() => {
  env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-crit-")) };
  fs.mkdirSync(path.join(env.SFO_HOME, "p", ".sfo"), { recursive: true });
});

const sample = [
  { id: "AC-001", group: "Enumeration", text: "A U+202F filename appears in the candidate set." },
  { id: "AC-002", group: "Enumeration", text: "Non-image files are excluded." },
  { id: "AC-003", group: "Naming", text: "Every produced filename is at most 255 bytes." },
];

describe("criteria", () => {
  it("round-trips through disk", () => {
    writeCriteria("p", sample, env);
    expect(readCriteria("p", env)).toHaveLength(3);
  });

  it("returns an empty list for a project with no criteria", () => {
    expect(readCriteria("p", env)).toEqual([]);
  });

  it("requires an id, a group, and text", () => {
    expect(CriterionSchema.safeParse({ id: "AC-001", group: "G" }).success).toBe(false);
    expect(CriterionSchema.safeParse({ id: "AC-001", group: "G", text: "t" }).success).toBe(true);
  });

  it("accepts an optional slice, so Plan B can add it without a migration", () => {
    expect(CriterionSchema.safeParse({ id: "AC-1", group: "G", text: "t", slice: "s1" }).success).toBe(true);
  });

  it("rejects duplicate ids, which would silently drop a criterion downstream", () => {
    const dupes = [sample[0], { ...sample[1], id: "AC-001" }];
    expect(() => writeCriteria("p", dupes, env)).toThrow(/duplicate/i);
  });

  it("groups in first-seen order, preserving the spec's sequence", () => {
    writeCriteria("p", sample, env);
    const groups = groupCriteria(readCriteria("p", env));
    expect([...groups.keys()]).toEqual(["Enumeration", "Naming"]);
    expect(groups.get("Enumeration")).toHaveLength(2);
  });
});

describe("duplicate ids on read", () => {
  it("rejects a hand-edited file containing duplicate ids", () => {
    // plan, test-write and review all readCriteria directly and key by id.
    // Write-time validation never sees a file edited outside the pipeline.
    fs.writeFileSync(
      path.join(env.SFO_HOME, "p", ".sfo", "CRITERIA.jsonl"),
      '{"id":"AC-001","group":"G","text":"one"}\n{"id":"AC-001","group":"G","text":"two"}\n',
    );
    expect(() => readCriteria("p", env)).toThrow(/duplicate criterion id: AC-001/);
  });
});
