import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeArtifact, readArtifact, appendArtifact, artifactExists } from "../../src/core/artifacts.js";

let env: Record<string, string>;

beforeEach(() => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sfo-"));
  env = { SFO_HOME: home };
  fs.mkdirSync(path.join(home, "p", ".sfo"), { recursive: true });
});

describe("artifacts", () => {
  it("writes and reads", () => {
    writeArtifact("p", "SPEC.md", "# Spec", env);
    expect(readArtifact("p", "SPEC.md", env)).toBe("# Spec");
  });

  it("reports existence", () => {
    expect(artifactExists("p", "SPEC.md", env)).toBe(false);
    writeArtifact("p", "SPEC.md", "x", env);
    expect(artifactExists("p", "SPEC.md", env)).toBe(true);
  });

  it("appends to an append-only artifact", () => {
    appendArtifact("p", "DECISIONS.md", "first", env);
    appendArtifact("p", "DECISIONS.md", "second", env);
    expect(readArtifact("p", "DECISIONS.md", env)).toBe("first\nsecond\n");
  });

  it("refuses to overwrite an append-only artifact", () => {
    appendArtifact("p", "DECISIONS.md", "first", env);
    expect(() => writeArtifact("p", "DECISIONS.md", "clobber", env)).toThrow(/append-only/i);
  });

  it("returns null for a missing artifact", () => {
    expect(readArtifact("p", "NOPE.md", env)).toBeNull();
  });
});
