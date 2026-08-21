import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { promptForAnswers } from "../../src/commands/answer.js";
import { writeState } from "../../src/core/state.js";
import { writeQuestions, readAnswers, type Questions } from "../../src/core/questions.js";

let env: Record<string, string>;

beforeEach(() => {
  env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-ans-")) };
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function question(id: string) {
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

describe("promptForAnswers", () => {
  function seedProject(questions: Questions) {
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
    writeQuestions("p", questions, env);
  }

  it("refuses an empty question list instead of writing an empty handoff", async () => {
    seedProject({ questions: [] });
    await expect(promptForAnswers("p", env)).rejects.toThrow(/contains no questions/);
  });

  it("reports a missing QUESTIONS.json rather than prompting for nothing", async () => {
    seedProject({ questions: [] });
    fs.rmSync(path.join(env.SFO_HOME, "p", ".sfo", "QUESTIONS.json"));
    await expect(promptForAnswers("p", env)).rejects.toThrow(/no QUESTIONS\.json for p/);
  });

  it("reports a missing project by name", async () => {
    await expect(promptForAnswers("ghost", env)).rejects.toThrow(/no such project/);
  });

  it("refuses to prompt when every question already has an answer", async () => {
    seedProject({ questions: [question("Q-001")] });
    await promptForAnswers("p", env, async () => "first");

    await expect(promptForAnswers("p", env, async () => "again")).rejects.toThrow(
      /no open questions for p/,
    );
  });

  it("asks only the new questions and keeps the earlier answers", async () => {
    seedProject({ questions: [question("Q-001"), question("Q-002")] });
    await promptForAnswers("p", env, async () => "first pass");

    // clarify folded those in and asked one more.
    writeQuestions(
      "p",
      { questions: [question("Q-001"), question("Q-002"), question("Q-003")] },
      env,
    );

    const asked: string[] = [];
    await promptForAnswers("p", env, async () => {
      asked.push("prompt");
      return "second pass";
    });

    expect(asked).toHaveLength(1);
    // questionText is recorded so a stage that reuses an id cannot inherit
    // an answer written against different wording.
    expect(readAnswers("p", env)?.answers).toEqual([
      { questionId: "Q-001", answer: "first pass", questionText: "question Q-001" },
      { questionId: "Q-002", answer: "first pass", questionText: "question Q-002" },
      { questionId: "Q-003", answer: "second pass", questionText: "question Q-003" },
    ]);
  });
});
