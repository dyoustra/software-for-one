import fs from "node:fs";
import { spawn } from "node:child_process";
import { logPath } from "../core/paths.js";
import { readState } from "../core/state.js";

export function showLogs(id: string, follow: boolean): void {
  const stage = readState(id).currentStage;
  const file = logPath(id, stage);
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
