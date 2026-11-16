import fs from "node:fs";
import path from "node:path";
import { artifactPath, type Env } from "../core/paths.js";
import { readState } from "../core/state.js";
import { PREFERENCES_JSON, PreferencesSchema, readPreferences } from "../core/preferences.js";
import { DEFAULT_MODELS, canonicalStage, familyFor, type Models } from "../core/models.js";
import type { Runner, RunStageInput, StageResult } from "./types.js";

/** The project's model choices: its own preferences snapshot, else the person's, else the defaults. */
export function projectModels(id: string, env?: Env): Models {
  try {
    const file = artifactPath(id, PREFERENCES_JSON, env);
    if (fs.existsSync(file)) return PreferencesSchema.parse(JSON.parse(fs.readFileSync(file, "utf8"))).models;
    return readPreferences(env).models;
  } catch {
    return DEFAULT_MODELS;
  }
}

/**
 * Gives each run the model family the person chose for its stage
 * (MODELS_SPEC §2), read when the run starts so a change made mid-project
 * applies from the next stage. A retry, which the project's state records
 * or this process has seen, runs one family up when escalation is on.
 */
export class ModelChoosingRunner implements Runner {
  private readonly started = new Set<string>();

  constructor(
    private readonly inner: Runner,
    private readonly id: string,
    private readonly env?: Env,
  ) {}

  async runStage(input: RunStageInput): Promise<StageResult> {
    const logName = path.basename(input.logPath, ".log");
    const retry = this.started.has(logName) || this.recordedAttempts(logName) > 0;
    this.started.add(logName);
    if (input.model || canonicalStage(logName) === null) return this.inner.runStage(input);
    return this.inner.runStage({ ...input, model: familyFor(logName, projectModels(this.id, this.env), retry) });
  }

  private recordedAttempts(logName: string): number {
    try {
      const state = readState(this.id, this.env);
      const slice = logName.match(/^build-(.+)$/)?.[1];
      return slice ? (state.sliceAttempts[slice] ?? 0) : (state.attempts[logName] ?? 0);
    } catch {
      return 0;
    }
  }
}
