import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { promptForAnswers } from "../../src/commands/answer.js";
import { writeState } from "../../src/core/state.js";
import { writeQuestions, type Questions } from "../../src/core/questions.js";

let env: Record<string, string>;

beforeEach(() => {
  env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-ans-")) };
});

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
});
