import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_MODELS, canonicalStage, changeModels, familyFor, modelName } from "../../src/core/models.js";
import { PreferencesSchema, readPreferences, setPreference } from "../../src/core/preferences.js";
import { ModelChoosingRunner } from "../../src/runner/models.js";
import { modelFromLog } from "../../src/runner/claude-code.js";
import { writeState } from "../../src/core/state.js";
import type { Runner, RunStageInput, StageResult } from "../../src/runner/types.js";

describe("which model a run gets", () => {
  it("finds the stage a run belongs to from its log's name", () => {
    expect(["research", "build-S-02", "adjudicate-S-01-answer", "feedback-3", "smoke-repair", "deliver", "mystery"].map(canonicalStage)).toEqual([
      "research",
      "build",
      "adjudicate",
      "feedback",
      "smoke",
      "deliver",
      null,
    ]);
  });

  it("uses the stage's group by default: thinking and building on Opus, writing on Sonnet", () => {
    expect(familyFor("plan", DEFAULT_MODELS, false)).toBe("opus");
    expect(familyFor("build-S-01", DEFAULT_MODELS, false)).toBe("opus");
    expect(familyFor("deliver", DEFAULT_MODELS, false)).toBe("sonnet");
  });

  it("lets a stage's own choice win over its group's", () => {
    expect(familyFor("deliver", { ...DEFAULT_MODELS, stages: { deliver: "haiku" } }, false)).toBe("haiku");
  });

  it("moves a retry one family up, when escalation is on, and never past Opus", () => {
    expect(familyFor("clarify", DEFAULT_MODELS, true)).toBe("opus");
    expect(familyFor("deliver", { ...DEFAULT_MODELS, stages: { deliver: "haiku" } }, true)).toBe("sonnet");
    expect(familyFor("plan", DEFAULT_MODELS, true)).toBe("opus");
    expect(familyFor("clarify", { ...DEFAULT_MODELS, escalate: false }, true)).toBe("sonnet");
  });

  it("names a model as people know it", () => {
    expect(modelName("claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelName("something-else")).toBe("something-else");
  });
});

describe("changing the choices", () => {
  it("sets a group, a stage, escalation, and puts a stage back on its group", () => {
    let m = changeModels(DEFAULT_MODELS, ["building", "sonnet"]);
    m = changeModels(m, ["review", "haiku"]);
    m = changeModels(m, ["escalate", "off"]);
    expect(m).toEqual({ thinking: "opus", building: "sonnet", writing: "sonnet", stages: { review: "haiku" }, escalate: false });
    expect(changeModels(m, ["review", "group"]).stages).toEqual({});
  });

  it("refuses what is not a stage, a group or a family", () => {
    expect(() => changeModels(DEFAULT_MODELS, ["build", "gpt"])).toThrow(/usage/);
    expect(() => changeModels(DEFAULT_MODELS, ["nonsense", "opus"])).toThrow(/no stage or group/);
  });
});

describe("model preferences", () => {
  let env: Record<string, string>;
  beforeEach(() => {
    env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-models-")) };
  });

  it("read as the defaults from a preferences file written before they existed", () => {
    fs.writeFileSync(path.join(env.SFO_HOME, "preferences.json"), JSON.stringify({ languages: { cli: [], web: [], mobile: [], firmware: [], default: [] }, webHost: "vercel", webData: "browser", budgetUsd: null, smokeCapUsd: 2 }));
    expect(readPreferences(env).models).toEqual(DEFAULT_MODELS);
  });

  it("change through sfo prefs models", () => {
    setPreference("models", ["writing", "haiku"], env);
    expect(readPreferences(env).models.writing).toBe("haiku");
  });
});

describe("the model-choosing runner", () => {
  let env: Record<string, string>;
  const calls: RunStageInput[] = [];
  const inner: Runner = {
    async runStage(input): Promise<StageResult> {
      calls.push(input);
      return { ok: true, exitCode: 0, logPath: input.logPath };
    },
  };
  const at = (stage: string) => path.join(env.SFO_HOME, "p", ".sfo", "logs", `${stage}.log`);

  beforeEach(() => {
    calls.length = 0;
    env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-mrun-")) };
    fs.mkdirSync(path.join(env.SFO_HOME, "p", ".sfo"), { recursive: true });
    writeState({ id: "p", title: "p", currentStage: "plan", status: "running", attempts: {}, pid: null, heartbeatAt: null, createdAt: "t", updatedAt: "t" }, env);
  });

  it("gives each run its stage's family, from the project's own preferences", async () => {
    const prefs = PreferencesSchema.parse({ languages: { cli: [], web: [], mobile: [], firmware: [], default: [] }, webHost: "vercel", webData: "browser", budgetUsd: null, smokeCapUsd: 2, models: { ...DEFAULT_MODELS, building: "sonnet" } });
    fs.writeFileSync(path.join(env.SFO_HOME, "p", ".sfo", "preferences.json"), JSON.stringify(prefs));
    const runner = new ModelChoosingRunner(inner, "p", env);
    await runner.runStage({ workdir: "/", prompt: "", logPath: at("plan") });
    await runner.runStage({ workdir: "/", prompt: "", logPath: at("build-S-01") });
    expect(calls.map((c) => c.model)).toEqual(["opus", "sonnet"]);
  });

  it("moves a stage's second try up a family", async () => {
    const runner = new ModelChoosingRunner(inner, "p", env);
    await runner.runStage({ workdir: "/", prompt: "", logPath: at("deliver") });
    await runner.runStage({ workdir: "/", prompt: "", logPath: at("deliver") });
    expect(calls.map((c) => c.model)).toEqual(["sonnet", "opus"]);
  });

  it("moves a slice that already failed once up a family, as the project's state records", async () => {
    writeState({ id: "p", title: "p", currentStage: "build", status: "running", attempts: {}, sliceAttempts: { "S-01": 1 }, pid: null, heartbeatAt: null, createdAt: "t", updatedAt: "t" }, env);
    const prefs = PreferencesSchema.parse({ languages: { cli: [], web: [], mobile: [], firmware: [], default: [] }, webHost: "vercel", webData: "browser", budgetUsd: null, smokeCapUsd: 2, models: { ...DEFAULT_MODELS, building: "haiku" } });
    fs.writeFileSync(path.join(env.SFO_HOME, "p", ".sfo", "preferences.json"), JSON.stringify(prefs));
    await new ModelChoosingRunner(inner, "p", env).runStage({ workdir: "/", prompt: "", logPath: at("build-S-01") });
    expect(calls[0].model).toBe("sonnet");
  });
});

describe("the model that ran", () => {
  it("is read from the run's first event", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sfo-mlog-")), "plan.log");
    fs.writeFileSync(file, `${JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-5-5", cwd: "/p" })}\n{"type":"assistant"}\n`);
    expect(modelFromLog(file)).toBe("claude-opus-5-5");
    expect(modelFromLog("/nonexistent.log")).toBeUndefined();
  });
});

describe("a project's own choices", () => {
  it("are kept in its preferences snapshot, for it alone, and only when valid", async () => {
    const { readProjectModels, setProjectModels } = await import("../../src/commands/models.js");
    const env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-pmodels-")) };
    fs.mkdirSync(path.join(env.SFO_HOME, "p", ".sfo"), { recursive: true });
    writeState({ id: "p", title: "p", currentStage: "plan", status: "running", attempts: {}, pid: null, heartbeatAt: null, createdAt: "t", updatedAt: "t" }, env);

    expect(readProjectModels("p", env)).toEqual(DEFAULT_MODELS);
    setProjectModels("p", { ...DEFAULT_MODELS, building: "haiku" }, env);
    expect(readProjectModels("p", env).building).toBe("haiku");
    expect(readPreferences(env).models.building).toBe("opus");
    expect(() => setProjectModels("p", { ...DEFAULT_MODELS, building: "gpt" }, env)).toThrow();
  });
});
