import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readSlices, writeSlices, type Slice } from "../../src/core/slices.js";
import { readCriteria, writeCriteria, type Criterion } from "../../src/core/criteria.js";
import { formatSlices } from "../../src/commands/slices.js";
import { buildProgram } from "../../src/cli.js";

let env: Record<string, string>;

beforeEach(() => {
  env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-slcmd-")) };
  fs.mkdirSync(path.join(env.SFO_HOME, "p", ".sfo"), { recursive: true });
});

const LONG =
  "Given a directory containing a file whose name uses a narrow no-break space, " +
  "the enumeration step lists that file exactly once and preserves the original " +
  "bytes of its name for later comparison.";

const criteria: Criterion[] = [
  { id: "AC-001", group: "Enumeration", text: "A U+202F filename appears in the candidate set." },
  { id: "AC-002", group: "Enumeration", text: LONG },
  { id: "AC-003", group: "Naming", text: "Every produced filename is at most 255 bytes." },
];

const slices: Slice[] = [
  { id: "S-01", name: "Enumeration", criterionIds: ["AC-001", "AC-002"], prerequisites: [] },
  { id: "S-02", name: "Naming", criterionIds: ["AC-003"], prerequisites: ["S-01"] },
];

/** Through the writers and readers, so no test can render a file the pipeline could not produce. */
function seed(s: Slice[], c: Criterion[]): [Slice[], Criterion[]] {
  writeSlices("p", s, env);
  writeCriteria("p", c, env);
  return [readSlices("p", env), readCriteria("p", env)];
}

describe("formatSlices", () => {
  it("shows each slice with its criterion count and criteria", () => {
    const out = formatSlices(...seed(slices, criteria));
    expect(out).toContain("S-01  Enumeration");
    expect(out).toContain("2 criteria");
    expect(out).toContain("1 criterion");
    expect(out).toContain("AC-003");
    expect(out).toContain("Every produced filename is at most 255 bytes.");
  });

  it("renders prerequisites, and says so when there are none", () => {
    const out = formatSlices(...seed(slices, criteria));
    expect(out).toContain("prerequisites: S-01");
    // Silence here reads as a rendering bug rather than an independent slice.
    expect(out).toContain("prerequisites: none");
  });

  it("keeps the file's order, which is the intended build order", () => {
    const out = formatSlices(...seed(slices, criteria));
    expect(out.indexOf("S-01")).toBeLessThan(out.indexOf("S-02"));
  });

  it("reports an empty set without crashing", () => {
    expect(formatSlices(readSlices("p", env), readCriteria("p", env))).toMatch(/no slices/i);
  });

  it("wraps long criterion text instead of running off the terminal", () => {
    const out = formatSlices(...seed(slices, criteria));
    for (const line of out.split("\n")) expect(line.length).toBeLessThanOrEqual(80);

    // Continuation lines line up under the text, so the id column stays readable.
    const wrapped = out.split("\n").filter((l) => /^ {14}\S/.test(l));
    expect(wrapped.length).toBeGreaterThan(0);
  });

  it("flags a criterion id no criterion matches, at the slice that names it", () => {
    const orphan: Slice[] = [{ ...slices[0], criterionIds: ["AC-001", "AC-999"] }];
    const out = formatSlices(...seed(orphan, criteria));
    expect(out).toContain("AC-999");
    expect(out).toMatch(/no such criterion/i);
  });

  it("warns about criteria no slice claims — those are never built at all", () => {
    const partial: Slice[] = [slices[0]];
    const out = formatSlices(...seed(partial, criteria));
    expect(out).toMatch(/no slice.*AC-003/);
  });

  it("says nothing about coverage when every criterion is claimed", () => {
    const out = formatSlices(...seed(slices, criteria));
    expect(out).not.toMatch(/warning/i);
  });
});

describe("sfo slices", () => {
  it("is registered on the program", () => {
    expect(buildProgram().commands.map((c) => c.name())).toContain("slices");
  });
});
