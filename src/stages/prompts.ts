import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export function loadPrompt(stage: string): string {
  const p = path.join(here, "prompts", `${stage}.md`);
  if (!fs.existsSync(p)) throw new Error(`no prompt for stage: ${stage}`);
  return fs.readFileSync(p, "utf8");
}
