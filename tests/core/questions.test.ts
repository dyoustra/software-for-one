import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  QuestionsSchema,
  readQuestions,
  writeQuestions,
  readAnswers,
  writeAnswers,
} from "../../src/core/questions.js";

let env: Record<string, string>;

beforeEach(() => {
  env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-q-")) };
  fs.mkdirSync(path.join(env.SFO_HOME, "p", ".sfo"), { recursive: true });
});

const questions = {
  questions: [
    {
      id: "Q-001",
      section: "blocking" as const,
      text: "Rename in place, or write a copy?",
      context: "This determines whether the tool mutates your originals at all.",
      options: [
        { key: "A", label: "Rename in place", tradeoff: "fastest; 4000 irreversible mutations" },
        { key: "B", label: "Hardlink into a new dir", tradeoff: "originals untouched; two folders" },
      ],
    },
  ],
};

describe("questions", () => {
  it("round-trips through disk", () => {
    writeQuestions("p", questions, env);
    expect(readQuestions("p", env)?.questions[0].text).toBe("Rename in place, or write a copy?");
  });

  it("returns null when no questions exist", () => {
    expect(readQuestions("p", env)).toBeNull();
  });

  it("accepts only blocking or preference as a section", () => {
    const bad = { questions: [{ ...questions.questions[0], section: "maybe" }] };
    expect(QuestionsSchema.safeParse(bad).success).toBe(false);
  });

  it("requires at least two options per question", () => {
    const bad = {
      questions: [{ ...questions.questions[0], options: [{ key: "A", label: "x", tradeoff: "y" }] }],
    };
    expect(QuestionsSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects duplicate question ids", () => {
    const dupes = { questions: [questions.questions[0], questions.questions[0]] };
    expect(() => writeQuestions("p", dupes, env)).toThrow(/duplicate/i);
  });

  it("stores an answer as the raw string the human typed", () => {
    // Free text is the escape hatch that makes multiple choice tolerable.
    writeAnswers("p", { answers: [{ questionId: "Q-001", answer: "a, but with a --materialize flag" }] }, env);
    expect(readAnswers("p", env)?.answers[0].answer).toContain("--materialize");
  });

  it("returns null when no answers exist", () => {
    expect(readAnswers("p", env)).toBeNull();
  });

  it("names the file when it is not valid JSON", () => {
    fs.writeFileSync(path.join(env.SFO_HOME, "p", ".sfo", "QUESTIONS.json"), "{ truncated");
    expect(() => readQuestions("p", env)).toThrow(/QUESTIONS\.json is not valid JSON/);
  });
});

describe("atomic writes", () => {
  it("leaves no temp file behind", () => {
    writeAnswers("p", { answers: [{ questionId: "Q-001", answer: "A" }] }, env);
    const files = fs.readdirSync(path.join(env.SFO_HOME, "p", ".sfo"));
    expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});
