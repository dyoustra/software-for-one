import path from "node:path";
import os from "node:os";

export type Env = Record<string, string | undefined>;

export function projectsRoot(env: Env = process.env): string {
  return env.SFO_HOME ?? path.join(env.HOME ?? os.homedir(), ".sfo");
}

export function projectDir(id: string, env: Env = process.env): string {
  return path.join(projectsRoot(env), id);
}

export function sfoDir(id: string, env: Env = process.env): string {
  return path.join(projectDir(id, env), ".sfo");
}

export function artifactPath(id: string, name: string, env: Env = process.env): string {
  return path.join(sfoDir(id, env), name);
}

export function logPath(id: string, stage: string, env: Env = process.env): string {
  return path.join(sfoDir(id, env), "logs", `${stage}.log`);
}
