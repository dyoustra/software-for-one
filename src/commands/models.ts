import fs from "node:fs";
import { artifactPath, sfoDir, type Env } from "../core/paths.js";
import { readState } from "../core/state.js";
import { PREFERENCES_JSON, PreferencesSchema, readPreferences, type Preferences } from "../core/preferences.js";
import { ModelsSchema, type Models } from "../core/models.js";

/** The project's preferences: the snapshot it started with, else the person's current ones. */
function projectPreferences(id: string, env?: Env): Preferences {
  const file = artifactPath(id, PREFERENCES_JSON, env);
  return fs.existsSync(file) ? PreferencesSchema.parse(JSON.parse(fs.readFileSync(file, "utf8"))) : readPreferences(env);
}

export function readProjectModels(id: string, env?: Env): Models {
  readState(id, env);
  return projectPreferences(id, env).models;
}

/**
 * This project's model choices (MODELS_SPEC §3), kept in its own preferences
 * snapshot: they win over the person's defaults, for this project only.
 */
export function setProjectModels(id: string, models: unknown, env?: Env): Models {
  readState(id, env);
  const valid = ModelsSchema.parse(models);
  const prefs = { ...projectPreferences(id, env), models: valid };
  fs.mkdirSync(sfoDir(id, env), { recursive: true });
  fs.writeFileSync(artifactPath(id, PREFERENCES_JSON, env), `${JSON.stringify(prefs, null, 2)}\n`);
  return valid;
}
