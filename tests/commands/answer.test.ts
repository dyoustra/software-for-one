import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { parseQuestions, renderAnswers, promptForAnswers } from "../../src/commands/answer.js";
import { writeState } from "../../src/core/state.js";
import { writeArtifact } from "../../src/core/artifacts.js";

let env: Record<string, string>;

beforeEach(() => {
  env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-ans-")) };
});

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

describe("promptForAnswers", () => {
  function seedProject(questionsBody: string) {
    fs.mkdirSync(path.join(env.SFO_HOME, "p", ".sfo"), { recursive: true });
    writeState(
      {
        id: "p",
        title: "T",
        currentStage: "clarify",
        status: "awaiting_human",
        attempts: {},
        pid: null,
        heartbeatAt: null,
        createdAt: "2026-08-21T00:00:00.000Z",
        updatedAt: "2026-08-21T00:00:00.000Z",
      },
      env,
    );
    writeArtifact("p", "QUESTIONS.md", questionsBody, env);
  }

  it("refuses an unparseable QUESTIONS.md instead of writing an empty handoff", async () => {
    seedProject("this file got mangled and has no questions in it");
    await expect(promptForAnswers("p", env)).rejects.toThrow(/no parseable questions/);
  });

  it("reports a missing project by name", async () => {
    await expect(promptForAnswers("ghost", env)).rejects.toThrow(/no such project/);
  });
});
