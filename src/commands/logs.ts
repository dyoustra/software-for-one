import fs from "node:fs";
import { spawn } from "node:child_process";
import { logPath } from "../core/paths.js";
import { readState } from "../core/state.js";
import type { Env } from "../core/paths.js";

export function showLogs(id: string, follow: boolean, env?: Env): void {
  const stage = readState(id, env).currentStage;
  const file = logPath(id, stage, env);
  if (!fs.existsSync(file)) {
    console.log(`no log yet for stage ${stage}`);
    return;
  }
  if (follow) {
    spawn("tail", ["-f", file], { stdio: "inherit" });
  } else {
    process.stdout.write(fs.readFileSync(file, "utf8"));
  }
}
