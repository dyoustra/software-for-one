import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createProject, slugify } from "../../src/commands/new.js";
import { readState } from "../../src/core/state.js";
import { readArtifact } from "../../src/core/artifacts.js";

let env: Record<string, string>;

beforeEach(() => {
  env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-new-")) };
});

const triageOk = vi.fn().mockResolvedValue({
  verdict: "ready",
  title: "Subway Tracker",
  reason: "clear",
  counterOffer: null,
});

describe("slugify", () => {
  it("makes a filesystem-safe slug", () => {
    expect(slugify("Subway Tracker!! v2")).toBe("subway-tracker-v2");
  });
});

describe("createProject", () => {
  it("writes IDEA.md and state.json", async () => {
    const id = await createProject("track the L train", triageOk, "aaa111", env);
    expect(id).toBe("subway-tracker-aaa111");
    expect(readArtifact(id, "IDEA.md", env)).toContain("track the L train");
    expect(readState(id, env).currentStage).toBe("capture");
  });

  it("initialises a git repo", async () => {
    const id = await createProject("track the L train", triageOk, "aaa111", env);
    expect(fs.existsSync(path.join(env.SFO_HOME, id, ".git"))).toBe(true);
  });

  it("stores the triage verdict as an artifact", async () => {
    const id = await createProject("track the L train", triageOk, "aaa111", env);
    expect(readArtifact(id, "TRIAGE.md", env)).toContain("ready");
  });

  it("still creates the project when triage says out of scope", async () => {
    const t = vi.fn().mockResolvedValue({
      verdict: "out_of_scope",
      title: "Train An LLM",
      reason: "not buildable",
      counterOffer: "an inference playground",
    });
    const id = await createProject("make an llm", t, "bbb222", env);
    expect(readState(id, env).status).toBe("awaiting_human");
    expect(readArtifact(id, "TRIAGE.md", env)).toContain("inference playground");
  });
});
