import { describe, it, expect } from "vitest";
import { parseQuestions, renderAnswers } from "../../src/commands/answer.js";

const SAMPLE = `## Blocking

### Native app or web app?
- [ ] A — Web app — fastest to build and deploy
- [ ] B — Native iOS — better offline story
- [ ] Other: ______

## Preference

### Which colour scheme?
- [ ] A — Light — default
- [ ] B — Dark — easier at night
- [ ] Other: ______
`;

describe("parseQuestions", () => {
  it("extracts every question with its section", () => {
    const qs = parseQuestions(SAMPLE);
    expect(qs).toHaveLength(2);
    expect(qs[0].section).toBe("Blocking");
    expect(qs[0].text).toBe("Native app or web app?");
    expect(qs[1].section).toBe("Preference");
  });

  it("extracts the options without the checkbox syntax", () => {
    const qs = parseQuestions(SAMPLE);
    expect(qs[0].options[0]).toBe("A — Web app — fastest to build and deploy");
    expect(qs[0].options).toHaveLength(3);
  });

  it("returns nothing for an empty document", () => {
    expect(parseQuestions("")).toEqual([]);
  });
});

describe("renderAnswers", () => {
  it("pairs each question with its answer", () => {
    const qs = parseQuestions(SAMPLE);
    const out = renderAnswers(qs, ["A — Web app", "B — Dark"]);
    expect(out).toContain("### Native app or web app?");
    expect(out).toContain("A — Web app");
    expect(out).toContain("B — Dark");
  });

  it("throws when the answer count does not match", () => {
    const qs = parseQuestions(SAMPLE);
    expect(() => renderAnswers(qs, ["only one"])).toThrow(/expected 2/i);
  });
});
