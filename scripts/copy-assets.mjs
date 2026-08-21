// tsc emits only .ts files, so the stage prompts never reach dist/ on their
// own and the built CLI throws `no prompt for stage:` at runtime. The tests
// don't catch this because they import from src/. Copying is the fix; the
// assertion afterwards is what stops it regressing silently — a copy that
// quietly no-ops is the same bug wearing a different hat.
import fs from "node:fs";
import path from "node:path";

const SRC = "src/stages/prompts";
const DEST = "dist/stages/prompts";
const REQUIRED = ["research.md", "spec.md", "clarify.md"];

fs.cpSync(SRC, DEST, { recursive: true });

const missing = REQUIRED.filter((f) => !fs.existsSync(path.join(DEST, f)));
if (missing.length > 0) {
  console.error(`copy-assets: missing from ${DEST}: ${missing.join(", ")}`);
  process.exit(1);
}
console.log(`copy-assets: ${REQUIRED.length} prompts -> ${DEST}`);
