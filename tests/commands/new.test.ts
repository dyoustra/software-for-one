import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createProject, slugify, warnSlowTriagePath } from "../../src/commands/new.js";
import { readState } from "../../src/core/state.js";
import { readArtifact } from "../../src/core/artifacts.js";
import { readCostRecords } from "../../src/core/cost.js";
import { readEstimate } from "../../src/core/estimate.js";
import { readAccess } from "../../src/core/access.js";

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

/** Triage now returns a rough estimate alongside the verdict, on one call. */
const ESTIMATE = {
  estimateLowUsd: 3,
  estimateHighUsd: 6,
  estimateBasis: "Single-purpose CLI with a handful of searches.",
};

const triageOk = vi.fn().mockResolvedValue({
  result: {
    verdict: "ready",
    title: "Subway Tracker",
    reason: "clear",
    counterOffer: null,
    ...ESTIMATE,
  },
  usage: USAGE,
  via: "cli",
});

describe("warnSlowTriagePath", () => {
  // The warning has to precede the call, not follow it: on the CLI path the
  // user otherwise waits ten seconds with no idea why.
  it("names the missing variable, both costs, and the fix on the cli path", () => {
    const lines: string[] = [];
    warnSlowTriagePath("cli", (m) => lines.push(m));

    const text = lines.join("\n");
    expect(text).toContain("ANTHROPIC_API_KEY");
    expect(text).toContain("claude CLI");
    expect(text).toMatch(/10s/);
    expect(text).toMatch(/2s/);
    expect(text).toMatch(/30x/);
  });

  it("stays quiet on the sdk path", () => {
    const lines: string[] = [];
    warnSlowTriagePath("sdk", (m) => lines.push(m));
    expect(lines).toEqual([]);
  });
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

  it("makes an initial commit, so the repo has a history to diff against", async () => {
    const id = await createProject("track the L train", triageOk, "aaa111", env);
    const dir = path.join(env.SFO_HOME, id);

    const tracked = execFileSync("git", ["show", "--name-only", "--format=", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);

    expect(tracked).toContain(".gitignore");
    expect(tracked).toContain(".sfo/IDEA.md");
    expect(tracked).toContain(".sfo/TRIAGE.md");
    expect(tracked).toContain(".sfo/state.json");
  });

  it("ignores stage logs, which are large and fully regenerable", async () => {
    const id = await createProject("track the L train", triageOk, "aaa111", env);
    const dir = path.join(env.SFO_HOME, id);
    fs.mkdirSync(path.join(dir, ".sfo", "logs"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".sfo", "logs", "research.log"), "x".repeat(1000));

    const status = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });
    expect(status).not.toContain("logs");
    expect(status.trim()).toBe("");
  });

  it("stores the triage verdict as an artifact", async () => {
    const id = await createProject("track the L train", triageOk, "aaa111", env);
    expect(readArtifact(id, "TRIAGE.md", env)).toContain("ready");
  });

  it("records the rough front-half estimate, before any of it is spent", async () => {
    const id = await createProject("track the L train", triageOk, "aaa111", env);
    const [front] = readEstimate(id, env);
    expect(front.phase).toBe("front");
    expect(front.lowUsd).toBe(3);
    expect(front.highUsd).toBe(6);
    expect(front.basis).toMatch(/CLI/);
  });

  it("commits the estimate with the capture snapshot", async () => {
    const id = await createProject("track the L train", triageOk, "aaa111", env);
    const tracked = execFileSync("git", ["show", "--name-only", "--format=", "HEAD"], {
      cwd: path.join(env.SFO_HOME, id),
      encoding: "utf8",
    });
    expect(tracked).toContain(".sfo/ESTIMATE.jsonl");
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

  it("records the route triage actually took", async () => {
    const t = vi.fn().mockResolvedValue({
      result: { verdict: "ready", title: "Fast Path", reason: "r", counterOffer: null, ...ESTIMATE },
      usage: USAGE,
      via: "sdk",
    });
    const id = await createProject("x", t, "ddd444", env);
    expect(readCostRecords(id, env)[0].via).toBe("sdk");
  });

  it("still creates the project when triage reports no usage", async () => {
    const t = vi.fn().mockResolvedValue({
      result: { verdict: "ready", title: "No Usage", reason: "r", counterOffer: null, ...ESTIMATE },
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
        ...ESTIMATE,
      },
    });
    const id = await createProject("make an llm", t, "bbb222", env);
    expect(readState(id, env).status).toBe("awaiting_human");
    expect(readArtifact(id, "TRIAGE.md", env)).toContain("inference playground");
  });
});

describe("createProject and model access", () => {
  it("snapshots the access it was given, so a later profile change cannot redesign it", async () => {
    const access = { modelAccess: ["anthropic_api_key" as const], sfoPrefers: "anthropic_api_key" as const };
    const id = await createProject("x", triageOk, "eee555", env, access);
    expect(readAccess(id, env)).toEqual(access);
  });

  it("writes no snapshot when none is given", async () => {
    const id = await createProject("x", triageOk, "fff666", env);
    expect(readAccess(id, env)).toBeNull();
  });

  it("records how triage was billed", async () => {
    const t = vi.fn().mockResolvedValue({
      result: { verdict: "ready", title: "Billed", reason: "r", counterOffer: null, ...ESTIMATE },
      usage: USAGE,
      via: "cli",
      billing: "plan",
    });
    const id = await createProject("x", t, "ggg777", env);
    expect(readCostRecords(id, env)[0].billing).toBe("plan");
  });
});
