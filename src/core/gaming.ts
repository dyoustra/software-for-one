import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SMOKE_DIR } from "./archetype.js";

/**
 * Marks of work left undone, in code a build agent just wrote. Strong signals
 * only: each one, in shipped code, means a path that does not do what it
 * claims. "mock" and "placeholder" were left out; both have honest uses in
 * product code, and a gate that cries wolf gets switched off.
 */
const MARKERS: { label: string; pattern: RegExp }[] = [
  { label: "TODO", pattern: /\bTODO\b/ },
  { label: "FIXME", pattern: /\bFIXME\b/ },
  { label: "not implemented", pattern: /not\s+implemented|NotImplementedError|unimplemented!/i },
  { label: "lorem ipsum", pattern: /lorem\s+ipsum/i },
];

/** Tests may say anything; so may the pipeline's own records and generated trees. */
const EXCLUDED = ["tests", SMOKE_DIR, ".sfo", "node_modules", ".venv", "dist", "build"];

export interface GamingHit {
  file: string;
  line: string;
  marker: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
}

const excluded = (file: string): boolean =>
  EXCLUDED.some((d) => file === d || file.startsWith(`${d}/`)) || file.endsWith(".md") || file.endsWith(".lock");

function scanLine(file: string, line: string, hits: GamingHit[]): void {
  for (const { label, pattern } of MARKERS) {
    if (pattern.test(line)) {
      hits.push({ file, line: line.trim().slice(0, 160), marker: label });
      return;
    }
  }
}

/**
 * Only the lines added since the last commit — this slice's own work. The
 * skeleton test-repair scaffolds is full of `raise NotImplementedError` stubs
 * that later slices replace, so scanning the whole tree would fail every early
 * slice for a later slice's stub. A stub or TODO written to get a test through
 * is exactly an added line.
 *
 * Returns nothing outside a git repository rather than guessing at a baseline.
 */
export function scanAddedLines(cwd: string): GamingHit[] {
  let diff: string;
  let untracked: string[];
  try {
    diff = git(cwd, ["diff", "HEAD", "--unified=0", "--no-color", "--no-ext-diff", "--", "."]);
    untracked = git(cwd, ["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean);
  } catch {
    return [];
  }

  const hits: GamingHit[] = [];
  let file: string | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const target = line.slice(4);
      file = target === "/dev/null" ? null : target.replace(/^b\//, "");
      continue;
    }
    if (file && !excluded(file) && line.startsWith("+") && !line.startsWith("+++")) scanLine(file, line.slice(1), hits);
  }
  for (const f of untracked) {
    if (excluded(f)) continue;
    let text: string;
    try {
      const full = path.join(cwd, f);
      if (fs.statSync(full).size > 2 * 1024 * 1024) continue;
      text = fs.readFileSync(full, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\u0000")) continue;
    for (const line of text.split("\n")) scanLine(f, line, hits);
  }
  return hits;
}

export function formatHits(hits: GamingHit[]): string {
  return [
    "Code this slice added still says it is unfinished. Finish it or remove the marker:",
    ...hits.map((h) => `  ${h.file}: [${h.marker}] ${h.line}`),
  ].join("\n");
}
