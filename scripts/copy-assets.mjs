// tsc emits only .ts files, so the stage prompts never reach dist/ on their
// own and the built CLI throws `no prompt for stage:` at runtime. The tests
// don't catch this because they import from src/. Copying is the fix; the
// assertions afterwards are what stop it regressing silently — a copy that
// quietly no-ops is the same bug wearing a different hat.
import fs from "node:fs";
import path from "node:path";

const SRC = "src/stages/prompts";
const DEST = "dist/stages/prompts";

/**
 * `capture` is triage, which runs before the project directory exists and gets
 * its instructions from a schema rather than a prompt file. Every other stage
 * loads `<stage>.md` at runtime.
 */
const NO_PROMPT = new Set(["capture"]);

fs.cpSync(SRC, DEST, { recursive: true });

const sources = fs.readdirSync(SRC).filter((f) => f.endsWith(".md"));
if (sources.length === 0) {
  console.error(`copy-assets: no prompts found in ${SRC}`);
  process.exit(1);
}

// Derived from what exists rather than a hardcoded list. The previous version
// named three files while nine existed, so the six newest prompts — the ones
// most likely to be missing — were the ones it did not check.
const notCopied = sources.filter((f) => !fs.existsSync(path.join(DEST, f)));

// tsc has already run, so the built sequence is readable here. This catches the
// opposite failure: a stage added to the pipeline with no prompt written for
// it, which surfaces as a runtime throw partway through a paid pipeline run.
const { PIPELINE_STAGES } = await import("../dist/core/stages.js");
const noPrompt = PIPELINE_STAGES.filter(
  (s) => !NO_PROMPT.has(s) && !fs.existsSync(path.join(DEST, `${s}.md`)),
);

if (notCopied.length > 0 || noPrompt.length > 0) {
  if (notCopied.length > 0) {
    console.error(`copy-assets: failed to copy into ${DEST}: ${notCopied.join(", ")}`);
  }
  if (noPrompt.length > 0) {
    console.error(`copy-assets: pipeline stages with no prompt: ${noPrompt.join(", ")}`);
  }
  process.exit(1);
}

// `npm link` points `sfo` straight at this file. Without the shebang the shell
// runs the JavaScript as a script: backticked help text like `sfo run` became
// command substitution, and each copy started another, until killed by hand.
const SHEBANG = "#!/usr/bin/env node\n";
if (!fs.readFileSync("dist/cli.js", "utf8").startsWith(SHEBANG)) {
  console.error("copy-assets: dist/cli.js does not start with a node shebang; the installed `sfo` would run as a shell script");
  process.exit(1);
}
fs.chmodSync("dist/cli.js", 0o755);

console.log(`copy-assets: ${sources.length} prompts -> ${DEST}`);
