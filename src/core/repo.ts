import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { projectDir, type Env } from "./paths.js";

/** Files named in a commit subject before it stops being readable. */
const MAX_NAMED_FILES = 5;

/**
 * A committer sfo supplies itself. Without `-c` overrides a machine with no
 * global `user.email` — every fresh machine — fails every commit, and the
 * project history the pipeline depends on silently never happens.
 */
const IDENTITY = ["-c", "user.name=sfo", "-c", "user.email=sfo@localhost"];

/**
 * Global config that would otherwise reach into these repos. `commit.gpgsign`
 * is the same class of hazard as a missing identity: a user who signs their own
 * commits has no key configured for sfo's committer, so every commit fails.
 * Hooks are skipped because a global `core.hooksPath` runs a hook written for
 * the user's own work against generated artifacts it knows nothing about.
 */
const NO_INTERFERENCE = ["-c", "commit.gpgsign=false"];

/**
 * `stage(spec): SPEC.md, QUESTIONS.md` — the stage that ran and what it
 * touched. Pure, so the interesting part is testable without spawning git.
 */
export function buildCommitMessage(stage: string, changedPaths: string[]): string {
  const names = [...new Set(changedPaths.map((p) => path.basename(p)))];
  if (names.length === 0) return `stage(${stage}): no files`;

  const shown = names.slice(0, MAX_NAMED_FILES).join(", ");
  const overflow = names.length - MAX_NAMED_FILES;
  return `stage(${stage}): ${shown}${overflow > 0 ? ` +${overflow} more` : ""}`;
}

function reason(err: unknown): string {
  const stderr = (err as { stderr?: Buffer | string })?.stderr?.toString().trim();
  const text = stderr || (err instanceof Error ? err.message : String(err));
  // Single line: this is a warning printed mid-pipeline, not a stack trace.
  return text.split("\n")[0] ?? "unknown error";
}

/**
 * Snapshots a project's artifacts as one commit, so a re-run of a stage can be
 * read as a diff instead of silently overwriting what came before.
 *
 * Deliberately swallows every git failure. A broken or missing repo costs the
 * user their history, which is bad; throwing here would cost them the stage
 * that just ran, which on `research` is minutes of work and real money.
 */
export function commitStage(
  id: string,
  stage: string,
  env?: Env,
  log: (message: string) => void = console.error,
): void {
  const cwd = projectDir(id, env);
  try {
    // `git add -A` walks up to the nearest repo. If a project lost its own
    // .git and SFO_HOME happens to sit inside another repo, that would stage
    // and commit the user's unrelated work under an sfo commit message.
    // realpath on both sides because macOS tmpdirs are symlinks.
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
    if (fs.realpathSync(root) !== fs.realpathSync(cwd)) {
      log(`sfo: could not commit ${stage} artifacts: ${cwd} is not its own git repo`);
      return;
    }

    execFileSync("git", ["add", "-A"], { cwd, stdio: "pipe" });

    const staged = execFileSync("git", ["diff", "--cached", "--name-only"], {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
    })
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    // A stage that changed nothing must not leave an empty commit behind —
    // that is noise in exactly the history someone is trying to read.
    if (staged.length === 0) return;

    execFileSync(
      "git",
      [
        ...IDENTITY,
        ...NO_INTERFERENCE,
        "commit",
        "--no-verify",
        "-m",
        buildCommitMessage(stage, staged),
      ],
      { cwd, stdio: "pipe" },
    );
  } catch (err) {
    log(`sfo: could not commit ${stage} artifacts: ${reason(err)}`);
  }
}
