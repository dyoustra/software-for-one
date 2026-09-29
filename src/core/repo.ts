import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { projectDir, type Env } from "./paths.js";
import { withheldFrom, type Withheld } from "./commitGuard.js";
import { appendDecision } from "./decisions.js";

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
/**
 * Bookkeeping files change on every single stage, so left unsorted they crowd
 * the real artifacts out of the subject line — `stage(spec)` would read
 * "COST.jsonl, DECISIONS.md, QUESTIONS.md, SPEC.md, state.json" and bury the
 * two files a reader actually cares about. They sort last so the named slots
 * go to what the stage produced.
 */
const BOOKKEEPING = new Set(["state.json", "COST.jsonl"]);

export function buildCommitMessage(stage: string, changedPaths: string[]): string {
  const names = [...new Set(changedPaths.map((p) => path.basename(p)))].sort((a, b) => {
    const aBook = BOOKKEEPING.has(a) ? 1 : 0;
    const bBook = BOOKKEEPING.has(b) ? 1 : 0;
    return aBook - bBook;
  });
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

const LOGS_IGNORE = ".sfo/logs/";

/**
 * The spec stage rewrites .gitignore once it has chosen a stack, and is told to
 * keep this line — but an instruction to a model is not a guarantee, and the
 * cost of it being dropped is silent: `git add -A` then commits roughly a
 * megabyte of stream-json stage logs per project, permanently. Re-asserting is
 * cheaper than trusting, and self-heals rather than failing the stage.
 */
function ensureLogsIgnored(cwd: string, log: (message: string) => void): void {
  const file = path.join(cwd, ".gitignore");
  try {
    const body = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (body.split("\n").some((line) => line.trim() === LOGS_IGNORE)) return;

    fs.writeFileSync(file, body.endsWith("\n") || body === "" ? `${body}${LOGS_IGNORE}\n` : `${body}\n${LOGS_IGNORE}\n`);
    log(`sfo: restored ${LOGS_IGNORE} to .gitignore — stage logs must not be committed`);
  } catch {
    // Best effort. A failure here must not cost the stage its commit.
  }
}

/**
 * Takes suspicious files out of the commit and keeps them out of every later
 * one. Files under `.sfo/` are only unstaged: ignoring one would drop the
 * pipeline's own record from history for good, so it is left for a person.
 */
function withhold(
  id: string,
  cwd: string,
  stage: string,
  withheld: Withheld[],
  env: Env | undefined,
  log: (message: string) => void,
): void {
  execFileSync("git", ["rm", "--cached", "-q", "--", ...withheld.map((w) => w.path)], { cwd, stdio: "pipe" });
  const ignorable = withheld.filter((w) => !w.path.startsWith(".sfo/"));
  if (ignorable.length > 0) {
    const file = path.join(cwd, ".gitignore");
    const body = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const lines = ignorable.map((w) => `/${w.path}`).filter((l) => !body.split("\n").includes(l));
    if (lines.length > 0) {
      const sep = body === "" || body.endsWith("\n") ? "" : "\n";
      fs.writeFileSync(file, `${body}${sep}# withheld by sfo's commit guard\n${lines.join("\n")}\n`);
      execFileSync("git", ["add", "--", ".gitignore"], { cwd, stdio: "pipe" });
    }
  }
  for (const w of withheld) log(`sfo: left ${w.path} out of the ${stage} commit — it ${w.why}`);
  try {
    appendDecision(
      id,
      {
        id: `D-withheld-${stage}-${Date.now()}`,
        decision: `What to do with ${withheld.map((w) => w.path).join(", ")} staged by ${stage}`,
        chose: "leave it out of history, and ignore it from now on (files under .sfo/ are only left out)",
        considered: "commit it; fail the stage",
        why: withheld.map((w) => `${w.path} ${w.why}`).join("; "),
        decided_by: "agent",
        blast_radius: "external",
        at: new Date().toISOString(),
      },
      env,
    );
  } catch {
    // The warning above is the part that must happen.
  }
}

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

    ensureLogsIgnored(cwd, log);

    execFileSync("git", ["add", "-A"], { cwd, stdio: "pipe" });

    const listStaged = (): string[] =>
      execFileSync("git", ["diff", "--cached", "--name-only"], { cwd, encoding: "utf8", stdio: "pipe" })
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

    // `-A` is unavoidable here — an agent's output cannot be listed ahead of
    // time — so what it staged is checked instead.
    const withheld = withheldFrom(cwd, listStaged());
    if (withheld.length > 0) withhold(id, cwd, stage, withheld, env, log);

    const staged = listStaged();

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

/**
 * `.sfo/` is left out of everything below. The orchestrator writes state, cost
 * and verify records there while these run, and a stash or checkout that took
 * them along would roll back the pipeline's own bookkeeping.
 */
const OUTSIDE_SFO = ["--", ".", ":(exclude).sfo"];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", [...IDENTITY, ...NO_INTERFERENCE, ...args], {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  });
}

/** Paths changed against HEAD, untracked included, `.sfo/` excluded. */
export function changedPaths(cwd: string): string[] {
  const out = git(cwd, ["status", "--porcelain", "-z", "--untracked-files=all", ...OUTSIDE_SFO]);
  const paths: string[] = [];
  const entries = out.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    // A rename is followed by its source path as a separate entry.
    if (entry[0] === "R" || entry[0] === "C") i++;
  }
  return paths.sort();
}

/**
 * Sets the working tree's uncommitted work aside. Returns whether anything
 * was stashed, since `stash pop` on an empty stash would pop someone else's.
 */
export function stashWork(cwd: string): boolean {
  if (changedPaths(cwd).length === 0) return false;
  git(cwd, ["stash", "push", "--include-untracked", "-m", "sfo: set aside", ...OUTSIDE_SFO]);
  return true;
}

/**
 * Brings stashed work back. If it no longer applies, because what was
 * committed meanwhile touched the same files, the work is discarded rather
 * than left as conflict markers for the next agent to build on. Returns
 * whether it came back.
 */
export function restoreWork(cwd: string, stashed: boolean): boolean {
  if (!stashed) return true;
  try {
    git(cwd, ["stash", "pop"]);
    return true;
  } catch {
    git(cwd, ["checkout", "HEAD", ...OUTSIDE_SFO]);
    git(cwd, ["clean", "-fd", ...OUTSIDE_SFO]);
    git(cwd, ["stash", "drop"]);
    return false;
  }
}

/** Puts the named paths back as HEAD has them; a path HEAD lacks is deleted. */
export function discardPaths(cwd: string, paths: string[]): void {
  for (const p of paths) {
    try {
      git(cwd, ["cat-file", "-e", `HEAD:${p}`]);
      git(cwd, ["checkout", "HEAD", "--", p]);
    } catch {
      fs.rmSync(path.join(cwd, p), { force: true });
    }
  }
}

export function headCommit(cwd: string): string {
  return git(cwd, ["rev-parse", "HEAD"]).trim();
}

/**
 * Undoes one commit's changes to the project, leaving `.sfo/` alone: a commit
 * made by `commitStage` also carries the pipeline's own state, costs and
 * findings, which a plain `git revert` would roll back too — and refuses to
 * try while they are being written. The reverse patch applies whole or not at
 * all, so a revert that conflicts with later work changes nothing: guessing
 * at a merge is how a rollback meant to restore known code produces unknown
 * code instead.
 */
export function revertCommit(cwd: string, sha: string): { ok: boolean; detail: string } {
  const short = sha.slice(0, 7);
  try {
    const patch = git(cwd, ["diff", "--binary", `${sha}^`, sha, ...OUTSIDE_SFO]);
    if (patch.trim() === "") return { ok: true, detail: `${short} changed nothing outside .sfo/` };
    execFileSync("git", ["apply", "-R", "--index", "-"], { cwd, input: patch, stdio: ["pipe", "pipe", "pipe"] });
    const subject = git(cwd, ["log", "-1", "--format=%s", sha]).trim();
    git(cwd, ["commit", "--no-verify", "-q", "-m", `Revert "${subject}" (sfo rollback of ${short})`]);
    return { ok: true, detail: `reverted ${short}` };
  } catch (err) {
    const stderr = (err as { stderr?: Buffer | string })?.stderr?.toString().trim();
    return { ok: false, detail: `could not revert ${short}: ${(stderr || String(err)).split("\n")[0]}` };
  }
}

/**
 * Commits exactly the named paths. For changes sfo can enumerate, unlike an
 * agent's output, which is why `commitStage` still has to stage everything.
 */
export function commitPaths(cwd: string, message: string, paths: string[]): void {
  if (paths.length === 0) return;
  git(cwd, ["add", "--", ...paths]);
  git(cwd, ["commit", "--no-verify", "-m", message, "--", ...paths]);
}
