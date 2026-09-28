import fs from "node:fs";
import { artifactPath, sfoDir, type Env } from "./paths.js";

export const STOPPED_FILE = "STOPPED.json";

/** That a person stopped the run, for `sfo status` to say so. Cleared when a run starts. */
export function writeStopped(id: string, stage: string, env?: Env): void {
  fs.mkdirSync(sfoDir(id, env), { recursive: true });
  fs.writeFileSync(artifactPath(id, STOPPED_FILE, env), `${JSON.stringify({ stage, at: new Date().toISOString() })}\n`);
}

export function isStopped(id: string, env?: Env): boolean {
  return fs.existsSync(artifactPath(id, STOPPED_FILE, env));
}

export function clearStopped(id: string, env?: Env): void {
  fs.rmSync(artifactPath(id, STOPPED_FILE, env), { force: true });
}

export const CRASH_FILE = "CRASH.json";

export interface Crash {
  stage: string;
  error: string;
  at: string;
}

/**
 * Why a run died. A detached run's output goes nowhere, so without this a
 * crash reads only as a heartbeat that stopped.
 */
export function writeCrash(id: string, crash: Crash, env?: Env): void {
  fs.mkdirSync(sfoDir(id, env), { recursive: true });
  fs.writeFileSync(artifactPath(id, CRASH_FILE, env), `${JSON.stringify(crash, null, 2)}\n`);
}

export function readCrash(id: string, env?: Env): Crash | null {
  try {
    return JSON.parse(fs.readFileSync(artifactPath(id, CRASH_FILE, env), "utf8")) as Crash;
  } catch {
    return null;
  }
}

export function clearCrash(id: string, env?: Env): void {
  fs.rmSync(artifactPath(id, CRASH_FILE, env), { force: true });
}

export const FAILURE_FILE = "FAILURE.json";

export interface Failure {
  stage: string;
  reason: string;
  at: string;
}

/** Why a stage failed, for `sfo status` and the notification. Cleared when a run starts. */
export function writeFailure(id: string, failure: Failure, env?: Env): void {
  fs.mkdirSync(sfoDir(id, env), { recursive: true });
  fs.writeFileSync(artifactPath(id, FAILURE_FILE, env), `${JSON.stringify(failure, null, 2)}\n`);
}

export function readFailure(id: string, env?: Env): Failure | null {
  try {
    return JSON.parse(fs.readFileSync(artifactPath(id, FAILURE_FILE, env), "utf8")) as Failure;
  } catch {
    return null;
  }
}

export function clearFailure(id: string, env?: Env): void {
  fs.rmSync(artifactPath(id, FAILURE_FILE, env), { force: true });
}

