import { describe, it, expect } from "vitest";
import { inline, parseCriteria, parseDecisions, parseMarkdown } from "../../app/src/lib/reports.js";

describe("a Markdown report", () => {
  it("reads headings, paragraphs, lists, code and inline marks", () => {
    const blocks = parseMarkdown(
      [
        "# Summary — `rolld`",
        "",
        "## What does not work",
        "",
        "- **No seam failed.** Nothing external.",
        "- Modifiers above 1,000,000 are",
        "  rejected (D-014).",
        "",
        "It runs from a new terminal.",
        "Second line of the same paragraph.",
        "",
        "```",
        "rolld 2d6+3",
        "```",
        "1. first",
        "2. second",
      ].join("\n"),
    );
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "heading", "list", "paragraph", "code", "list"]);
    expect(blocks[0]).toEqual({ kind: "heading", level: 1, text: [{ text: "Summary — " }, { text: "rolld", style: "code" }] });
    expect(blocks[2]).toMatchObject({ ordered: false, items: [[{ text: "No seam failed.", style: "strong" }, { text: " Nothing external." }], [{ text: "Modifiers above 1,000,000 are rejected (D-014)." }]] });
    expect(blocks[3]).toEqual({ kind: "paragraph", text: [{ text: "It runs from a new terminal. Second line of the same paragraph." }] });
    expect(blocks[4]).toEqual({ kind: "code", text: "rolld 2d6+3" });
    expect(blocks[5]).toMatchObject({ ordered: true, items: [[{ text: "first" }], [{ text: "second" }]] });
  });

  it("keeps bold that contains code bold, without its backticks", () => {
    expect(inline("**No `high` findings.** Three low.")).toEqual([{ text: "No high findings.", style: "strong" }, { text: " Three low." }]);
  });

  it("leaves text with no marks as one plain run", () => {
    expect(inline("plain words")).toEqual([{ text: "plain words" }]);
  });
});

describe("the decisions report", () => {
  it("reads each decision, and who made it", () => {
    const d = parseDecisions(
      "D-001  [structural]  decided by agent\n  Language\n  chose: Python 3.10+ stdlib only\n  why:   First-ranked CLI preference.\n\nD-009  [structural]  decided by human\n  Name\n  chose: C: rolld\n  why:   Chose rolld.\n",
    );
    expect(d).toEqual([
      { id: "D-001", scope: "structural", byHuman: false, title: "Language", chose: "Python 3.10+ stdlib only", why: "First-ranked CLI preference." },
      { id: "D-009", scope: "structural", byHuman: true, title: "Name", chose: "C: rolld", why: "Chose rolld." },
    ]);
  });

  it("does not pretend to read text in another shape", () => {
    expect(parseDecisions("no decisions yet")).toBeNull();
  });
});

describe("the criteria report", () => {
  it("groups criteria under their headings, joining wrapped lines", () => {
    const g = parseCriteria("\nParsing\n  AC-001   `2d6+3` parses as one term.\n  AC-002   `d6` parses as one die,\n           with the count omitted.\n\nOutput\n  AC-014   One line.\n");
    expect(g).toEqual([
      { name: "Parsing", items: [{ id: "AC-001", text: "`2d6+3` parses as one term." }, { id: "AC-002", text: "`d6` parses as one die, with the count omitted." }] },
      { name: "Output", items: [{ id: "AC-014", text: "One line." }] },
    ]);
  });

  it("does not pretend to read text in another shape", () => {
    expect(parseCriteria("nothing here")).toBeNull();
  });
});
