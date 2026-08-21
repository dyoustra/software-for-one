import { describe, it, expect } from "vitest";
import { formatCriteria } from "../../src/commands/criteria.js";
import { formatDecisions } from "../../src/commands/decisions.js";

const criteria = [
  { id: "AC-001", group: "Enumeration", text: "A U+202F filename appears in the candidate set." },
  { id: "AC-002", group: "Enumeration", text: "Non-image files are excluded." },
  { id: "AC-003", group: "Naming", text: "Filenames are at most 255 bytes." },
];

const decisions = [
  {
    id: "D-001", decision: "App-first slugs", chose: "app leads", considered: "subject-first",
    why: "browsing beats searching here", decided_by: "human" as const,
    blast_radius: "structural" as const, at: "2026-08-21T18:00:00.000Z",
  },
  {
    id: "D-002", decision: "Dry-run default", chose: "dry-run", considered: "apply by default",
    why: "destructive", decided_by: "agent" as const,
    blast_radius: "local" as const, at: "2026-08-21T18:00:00.000Z",
  },
];

describe("formatCriteria", () => {
  it("groups criteria under their headings with a count", () => {
    const out = formatCriteria(criteria);
    expect(out).toContain("Enumeration");
    expect(out).toContain("AC-001");
    expect(out).toMatch(/3 criteria/);
  });

  it("reports an empty set without crashing", () => {
    expect(formatCriteria([])).toMatch(/no criteria/i);
  });
});

describe("formatDecisions", () => {
  it("shows who decided and the blast radius", () => {
    const out = formatDecisions(decisions);
    expect(out).toContain("human");
    expect(out).toContain("structural");
  });

  it("puts structural and external decisions first", () => {
    // The expensive-to-reverse calls should be the first thing read, not
    // buried among forty local ones.
    const out = formatDecisions(decisions);
    expect(out.indexOf("D-001")).toBeLessThan(out.indexOf("D-002"));
  });

  it("reports an empty set without crashing", () => {
    expect(formatDecisions([])).toMatch(/no decisions/i);
  });
});
