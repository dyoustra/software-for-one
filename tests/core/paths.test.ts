import { describe, it, expect } from "vitest";
import { projectsRoot, projectDir, sfoDir, artifactPath, logPath } from "../../src/core/paths.js";

describe("paths", () => {
  it("honours SFO_HOME", () => {
    expect(projectsRoot({ SFO_HOME: "/tmp/x" })).toBe("/tmp/x");
  });

  it("defaults under the home directory", () => {
    expect(projectsRoot({ HOME: "/Users/ada" })).toBe("/Users/ada/.sfo");
  });

  it("derives project paths from the root", () => {
    const env = { SFO_HOME: "/tmp/x" };
    expect(projectDir("abc", env)).toBe("/tmp/x/abc");
    expect(sfoDir("abc", env)).toBe("/tmp/x/abc/.sfo");
    expect(artifactPath("abc", "SPEC.md", env)).toBe("/tmp/x/abc/.sfo/SPEC.md");
    expect(logPath("abc", "research", env)).toBe("/tmp/x/abc/.sfo/logs/research.log");
  });
});
