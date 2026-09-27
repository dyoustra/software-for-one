import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { scanAddedLines, formatHits } from "../../src/core/gaming.js";

let dir: string;

function git(...args: string[]): void {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, stdio: "pipe" });
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sfo-gaming-"));
  git("init", "-q");
  // The skeleton test-repair leaves: stubs every later slice replaces.
  write("src/app/naming.py", "def name_for(x):\n    raise NotImplementedError\n");
  write("src/app/plan.py", "def plan():\n    raise NotImplementedError\n");
  git("add", "-A");
  git("commit", "-q", "-m", "skeleton");
});

describe("scanAddedLines", () => {
  it("ignores the skeleton's stubs, which were there before this slice", () => {
    write("src/app/naming.py", "def name_for(x):\n    return x.lower()\n");
    expect(scanAddedLines(dir)).toEqual([]);
  });

  it("flags a stub or TODO this slice added, in changed and new files", () => {
    write("src/app/naming.py", "def name_for(x):\n    # TODO handle unicode\n    return x\n");
    write("src/app/report.py", "def report():\n    raise NotImplementedError('later')\n");
    write("src/app/copy.py", "BLURB = 'Lorem ipsum dolor sit amet'\n");
    const hits = scanAddedLines(dir);
    expect(hits.map((h) => [h.file, h.marker])).toEqual([
      ["src/app/naming.py", "TODO"],
      ["src/app/copy.py", "lorem ipsum"],
      ["src/app/report.py", "not implemented"],
    ]);
    expect(formatHits(hits)).toContain("src/app/naming.py: [TODO] # TODO handle unicode");
  });

  it("lets tests, smoke tests, docs and the pipeline's records say anything", () => {
    write("tests/test_x.py", "# TODO more cases\n");
    write("smoke/test_smoke_x.py", "# FIXME\n");
    write("README.md", "TODO: screenshots\n");
    write(".sfo/DECISIONS.jsonl", '{"why":"not implemented yet"}\n');
    expect(scanAddedLines(dir)).toEqual([]);
  });

  it("finds nothing to judge outside a git repository", () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "sfo-gaming-bare-"));
    fs.writeFileSync(path.join(bare, "a.py"), "# TODO\n");
    expect(scanAddedLines(bare)).toEqual([]);
  });
});
