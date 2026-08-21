import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitStage, buildCommitMessage } from "../../src/core/repo.js";

let env: Record<string, string>;

function projectPath(id: string, ...rest: string[]): string {
  return path.join(env.SFO_HOME, id, ...rest);
}

/** Creates the project directory and, unless told otherwise, a git repo in it. */
function makeProject(id: string, { git = true } = {}): string {
  const dir = projectPath(id);
  fs.mkdirSync(path.join(dir, ".sfo"), { recursive: true });
  if (git) execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

/** Commit subjects, newest first. Empty on an unborn branch. */
function subjects(dir: string): string[] {
  const out = execFileSync("git", ["log", "--format=%s"], { cwd: dir, encoding: "utf8" });
  return out.split("\n").filter(Boolean);
}

function commitCount(dir: string): number {
  return Number(
    execFileSync("git", ["rev-list", "--all", "--count"], { cwd: dir, encoding: "utf8" }).trim(),
  );
}

beforeEach(() => {
  env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-repo-")) };
});

describe("buildCommitMessage", () => {
  it("names the stage and the artifacts that changed", () => {
    expect(buildCommitMessage("spec", [".sfo/SPEC.md", ".sfo/QUESTIONS.md"])).toBe(
      "stage(spec): SPEC.md, QUESTIONS.md",
    );
  });

  it("strips directory prefixes so the subject stays readable", () => {
    expect(buildCommitMessage("capture", [".gitignore", ".sfo/IDEA.md"])).toBe(
      "stage(capture): .gitignore, IDEA.md",
    );
  });

  it("caps a long list instead of emitting an unreadable subject line", () => {
    const many = ["a", "b", "c", "d", "e", "f", "g"].map((n) => `.sfo/${n}.md`);
    const message = buildCommitMessage("research", many);
    expect(message).toBe("stage(research): a.md, b.md, c.md, d.md, e.md +2 more");
    expect(message.length).toBeLessThanOrEqual(72);
  });

  it("still produces a valid subject when nothing is named", () => {
    expect(buildCommitMessage("spec", [])).toBe("stage(spec): no files");
  });
});

describe("commitStage", () => {
  it("commits the artifacts on disk", () => {
    const dir = makeProject("p");
    fs.writeFileSync(projectPath("p", ".sfo", "SPEC.md"), "# Spec\n");

    commitStage("p", "spec", env);

    expect(commitCount(dir)).toBe(1);
    expect(subjects(dir)[0]).toBe("stage(spec): SPEC.md");
  });

  it("makes the artifact retrievable from history afterwards", () => {
    const dir = makeProject("p");
    fs.writeFileSync(projectPath("p", ".sfo", "SPEC.md"), "# Spec\nthe body\n");

    commitStage("p", "spec", env);

    const shown = execFileSync("git", ["show", "HEAD:.sfo/SPEC.md"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(shown).toBe("# Spec\nthe body\n");
  });

  it("leaves a diff between two runs of the same stage", () => {
    const dir = makeProject("p");
    fs.writeFileSync(projectPath("p", ".sfo", "SPEC.md"), "first\n");
    commitStage("p", "spec", env);
    fs.writeFileSync(projectPath("p", ".sfo", "SPEC.md"), "second\n");
    commitStage("p", "spec", env);

    const diff = execFileSync("git", ["diff", "HEAD~1", "HEAD", "--", ".sfo/SPEC.md"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(diff).toContain("-first");
    expect(diff).toContain("+second");
  });

  it("does not create an empty commit when a stage changed nothing", () => {
    const dir = makeProject("p");
    fs.writeFileSync(projectPath("p", ".sfo", "SPEC.md"), "# Spec\n");

    commitStage("p", "spec", env);
    commitStage("p", "spec", env);

    expect(commitCount(dir)).toBe(1);
  });

  it("commits regardless of the user's global git identity", () => {
    // A fresh machine has no global user.email, which would otherwise fail
    // every commit sfo tries to make.
    const dir = makeProject("p");
    fs.writeFileSync(projectPath("p", ".sfo", "SPEC.md"), "# Spec\n");
    commitStage("p", "spec", env);

    const author = execFileSync("git", ["log", "-1", "--format=%an <%ae>"], {
      cwd: dir,
      encoding: "utf8",
    }).trim();
    expect(author).toBe("sfo <sfo@localhost>");
  });

  it("warns and returns rather than throwing when the directory is not a git repo", () => {
    makeProject("p", { git: false });
    fs.writeFileSync(projectPath("p", ".sfo", "SPEC.md"), "# Spec\n");

    const warnings: string[] = [];
    expect(() => commitStage("p", "spec", env, (m) => warnings.push(m))).not.toThrow();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("could not commit spec artifacts");
    expect(warnings[0]).not.toContain("\n");
  });

  it("never commits into an enclosing repo when the project has no .git of its own", () => {
    // `git add -A` walks up to the nearest repo. Staging the user's unrelated
    // work under an sfo commit message is far worse than losing the history.
    execFileSync("git", ["init", "-q"], { cwd: env.SFO_HOME });
    fs.writeFileSync(path.join(env.SFO_HOME, "unrelated-work.txt"), "do not touch\n");
    makeProject("p", { git: false });
    fs.writeFileSync(projectPath("p", ".sfo", "SPEC.md"), "# Spec\n");

    const warnings: string[] = [];
    commitStage("p", "spec", env, (m) => warnings.push(m));

    expect(warnings).toHaveLength(1);
    expect(commitCount(env.SFO_HOME)).toBe(0);
    const staged = execFileSync("git", ["diff", "--cached", "--name-only"], {
      cwd: env.SFO_HOME,
      encoding: "utf8",
    });
    expect(staged.trim()).toBe("");
  });

  it("warns and returns rather than throwing when the project does not exist", () => {
    const warnings: string[] = [];
    expect(() => commitStage("nope", "spec", env, (m) => warnings.push(m))).not.toThrow();
    expect(warnings).toHaveLength(1);
  });
});

describe("buildCommitMessage bookkeeping ordering", () => {
  it("names the stage's real artifacts before state.json and COST.jsonl", () => {
    // These two change on every stage; unsorted they crowd out the artifacts
    // the reader actually wants to see in the subject line.
    const msg = buildCommitMessage("spec", [
      ".sfo/state.json",
      ".sfo/COST.jsonl",
      ".sfo/SPEC.md",
      ".sfo/QUESTIONS.md",
      ".sfo/DECISIONS.md",
    ]);
    expect(msg).toContain("SPEC.md");
    expect(msg.indexOf("SPEC.md")).toBeLessThan(msg.indexOf("state.json"));
    expect(msg.indexOf("DECISIONS.md")).toBeLessThan(msg.indexOf("COST.jsonl"));
  });
});
