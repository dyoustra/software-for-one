import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createProject, slugify } from "../../src/commands/new.js";
import { readState } from "../../src/core/state.js";
import { readArtifact } from "../../src/core/artifacts.js";
import { readCostRecords } from "../../src/core/cost.js";

let env: Record<string, string>;

beforeEach(() => {
  env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-new-")) };
});

const USAGE = {
  costUsd: 0.34,
  durationMs: 1000,
  numTurns: 1,
  inputTokens: 1,
  outputTokens: 2,
  cacheCreationInputTokens: 3,
  cacheReadInputTokens: 4,
};

const triageOk = vi.fn().mockResolvedValue({
  result: {
    verdict: "ready",
    title: "Subway Tracker",
    reason: "clear",
    counterOffer: null,
  },
  usage: USAGE,
});

describe("slugify", () => {
  it("makes a filesystem-safe slug", () => {
    expect(slugify("Subway Tracker!! v2")).toBe("subway-tracker-v2");
  });

  it("falls back to a usable name when a title slugs to nothing", () => {
    // An id like "-a1b2c3" is a directory commander parses as an option,
    // which makes `sfo run <id>` untypeable.
    expect(slugify("日本語")).toBe("project");
    expect(slugify("!!!")).toBe("project");
  });

  it("never emits a trailing dash when the 40-char cut lands on a separator", () => {
    const slug = slugify("a".repeat(40) + " tail");
    expect(slug.endsWith("-")).toBe(false);
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

  it("refuses to clobber an existing project on id collision", async () => {
    await createProject("first idea", triageOk, "aaa111", env);
    await expect(createProject("second idea", triageOk, "aaa111", env)).rejects.toThrow(
      /already exists/,
    );
    // The original project must be untouched, not appended to.
    expect(readArtifact("subway-tracker-aaa111", "IDEA.md", env)).toBe("first idea\n");
  });

  it("records what triage spent, so it shows up in sfo cost", async () => {
    const id = await createProject("track the L train", triageOk, "aaa111", env);
    const records = readCostRecords(id, env);
    expect(records.map((r) => r.stage)).toContain("triage");
    expect(records.find((r) => r.stage === "triage")?.usage.costUsd).toBe(0.34);
  });

  it("still creates the project when triage reports no usage", async () => {
    const t = vi.fn().mockResolvedValue({
      result: { verdict: "ready", title: "No Usage", reason: "r", counterOffer: null },
    });
    const id = await createProject("x", t, "ccc333", env);
    expect(readCostRecords(id, env)).toEqual([]);
  });

  it("still creates the project when triage says out of scope", async () => {
    const t = vi.fn().mockResolvedValue({
      result: {
        verdict: "out_of_scope",
        title: "Train An LLM",
        reason: "not buildable",
        counterOffer: "an inference playground",
      },
    });
    const id = await createProject("make an llm", t, "bbb222", env);
    expect(readState(id, env).status).toBe("awaiting_human");
    expect(readArtifact(id, "TRIAGE.md", env)).toContain("inference playground");
  });
});
