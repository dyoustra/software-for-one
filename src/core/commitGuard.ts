import fs from "node:fs";
import path from "node:path";

/** Past this, a file is a build product or a dataset, not source. */
export const MAX_COMMITTED_BYTES = 5 * 1024 * 1024;

/** Only text this small is read for key-shaped strings. */
const MAX_SCANNED_BYTES = 1024 * 1024;

const SECRET_NAMES: { label: string; test: (name: string) => boolean }[] = [
  // .env.example and friends are templates, committed on purpose.
  { label: "an environment file", test: (n) => /^\.env(\..+)?$/.test(n) && !/\.(example|sample|template)$/.test(n) },
  { label: "a key or certificate file", test: (n) => /\.(pem|key|p12|pfx)$/.test(n) },
  { label: "an SSH private key", test: (n) => /^id_(rsa|dsa|ecdsa|ed25519)$/.test(n) },
];

/**
 * Shapes real credentials have. Long enough that a test fixture's
 * `sk-ant-test-key` does not match: the first project's suite used exactly
 * that, and withholding a test file would break the build it guards.
 */
const SECRET_CONTENT: { label: string; pattern: RegExp }[] = [
  { label: "an Anthropic API key", pattern: /sk-ant-[A-Za-z0-9_-]{40,}/ },
  { label: "an OpenAI API key", pattern: /\bsk-(proj-)?[A-Za-z0-9_-]{40,}/ },
  { label: "a GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,}/ },
  { label: "an AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "a Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{20,}/ },
  { label: "a private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

export interface Withheld {
  path: string;
  why: string;
}

/**
 * Staged paths that must not reach history. History is permanent in a way the
 * working tree is not: a key committed once is a key leaked, whatever a later
 * commit deletes.
 */
export function withheldFrom(cwd: string, staged: string[]): Withheld[] {
  const out: Withheld[] = [];
  for (const rel of staged) {
    const full = path.join(cwd, rel);
    let size: number;
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile()) continue;
      size = stat.size;
    } catch {
      continue; // a staged deletion
    }

    const named = SECRET_NAMES.find((s) => s.test(path.basename(rel)));
    if (named) {
      out.push({ path: rel, why: `looks like ${named.label}` });
      continue;
    }
    if (size > MAX_COMMITTED_BYTES) {
      out.push({ path: rel, why: `is ${(size / 1024 / 1024).toFixed(1)} MB, over the ${MAX_COMMITTED_BYTES / 1024 / 1024} MB limit` });
      continue;
    }
    if (size > MAX_SCANNED_BYTES) continue;
    let text: string;
    try {
      text = fs.readFileSync(full, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\u0000")) continue;
    const found = SECRET_CONTENT.find((s) => s.pattern.test(text));
    if (found) out.push({ path: rel, why: `contains what looks like ${found.label}` });
  }
  return out;
}
