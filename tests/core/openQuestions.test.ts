import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openQuestions } from "../../src/core/openQuestions.js";
import { writeQuestions, writeAnswers } from "../../src/core/questions.js";

let env: Record<string, string>;

function q(id: string) {
  return {
    id,
    section: "blocking" as const,
    text: `question ${id}`,
    context: "",
    options: [
      { key: "A", label: "a", tradeoff: "" },
      { key: "B", label: "b", tradeoff: "" },
    ],
  };
}

beforeEach(() => {
  env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-oq-")) };
  fs.mkdirSync(path.join(env.SFO_HOME, "p", ".sfo"), { recursive: true });
});

describe("openQuestions", () => {
  it("returns every question when nothing has been answered", () => {
    writeQuestions("p", { questions: [q("Q-001"), q("Q-002")] }, env);
    expect(openQuestions("p", env).map((x) => x.id)).toEqual(["Q-001", "Q-002"]);
  });

  it("returns nothing when every question has an answer", () => {
    writeQuestions("p", { questions: [q("Q-001")] }, env);
    writeAnswers("p", { answers: [{ questionId: "Q-001", answer: "A" }] }, env);
    expect(openQuestions("p", env)).toEqual([]);
  });

  it("returns only the questions clarify added after the last answers", () => {
    // The fast-loop case: clarify folded in the answers and asked something new.
    writeQuestions("p", { questions: [q("Q-001")] }, env);
    writeAnswers("p", { answers: [{ questionId: "Q-001", answer: "A" }] }, env);
    writeQuestions("p", { questions: [q("Q-001"), q("Q-002")] }, env);

    expect(openQuestions("p", env).map((x) => x.id)).toEqual(["Q-002"]);
  });

  it("treats a blank answer as answered — the human chose to skip it", () => {
    writeQuestions("p", { questions: [q("Q-001")] }, env);
    writeAnswers("p", { answers: [{ questionId: "Q-001", answer: "" }] }, env);
    expect(openQuestions("p", env)).toEqual([]);
  });

  it("returns nothing when no questions exist at all", () => {
    expect(openQuestions("p", env)).toEqual([]);
  });
});
