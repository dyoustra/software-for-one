import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { guardRunnable, detachedArgs, runnerFor } from "../../src/commands/run.js";
import { FallbackRunner } from "../../src/runner/fallback.js";
import { writeState, type ProjectState } from "../../src/core/state.js";
import { writePriorArt, type PriorArt } from "../../src/core/priorart.js";
import { writeBudget } from "../../src/core/budget.js";
import { recordCost } from "../../src/core/cost.js";
import { writeProfile, writeAccess } from "../../src/core/access.js";

let env: Record<string, string>;

function seed(
  status: ProjectState["status"],
  heartbeatAt: string | null = null,
  currentStage = "research",
) {
  fs.mkdirSync(path.join(env.SFO_HOME, "p", ".sfo"), { recursive: true });
  writeState(
    {
      id: "p",
      title: "T",
      currentStage,
      status,
      attempts: {},
      pid: status === "running" ? 4321 : null,
      heartbeatAt,
      createdAt: "2026-08-21T00:00:00.000Z",
      updatedAt: "2026-08-21T00:00:00.000Z",
    },
    env,
  );
}

const noGap: PriorArt = {
  verdict: "no_gap",
  summary: "ai-renamer does this already.",
  existing: [{ name: "ai-renamer", url: "https://example.com", gap: "none worth the build" }],
  recommendation: "use ai-renamer instead",
};

beforeEach(() => {
  env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-run-")) };
});

describe("guardRunnable", () => {
  it("allows a project waiting on a human", () => {
    seed("awaiting_human");
    expect(() => guardRunnable("p", env)).not.toThrow();
  });

  it("refuses a failed project instead of letting the detached child die silently", () => {
    // The detached child runs with stdio: "ignore", so a throw inside it is
    // discarded after the parent already printed "started (pid N)".
    seed("failed");
    expect(() => guardRunnable("p", env)).toThrow(/failed at stage "research"/);
  });

  it("refuses a project that is genuinely still running", () => {
    seed("running", new Date().toISOString());
    expect(() => guardRunnable("p", env)).toThrow(/already running/);
  });

  it("allows a running project whose heartbeat went stale", () => {
    seed("running", "2020-01-01T00:00:00.000Z");
    expect(() => guardRunnable("p", env)).not.toThrow();
  });
});

describe("guardRunnable and the prior-art verdict", () => {
  it("refuses a no_gap project, naming the recommendation and the override", () => {
    seed("awaiting_human");
    writePriorArt("p", noGap, env);
    expect(() => guardRunnable("p", env)).toThrow(/use ai-renamer instead/);
    expect(() => guardRunnable("p", env)).toThrow(/sfo run p --anyway/);
  });

  it("refuses a marginal_gap project", () => {
    seed("awaiting_human");
    writePriorArt("p", { verdict: "marginal_gap", summary: "close", existing: [] }, env);
    expect(() => guardRunnable("p", env)).toThrow(/prior art/);
  });

  it("proceeds anyway when the human says so", () => {
    seed("awaiting_human");
    writePriorArt("p", noGap, env);
    expect(() => guardRunnable("p", env, { anyway: true })).not.toThrow();
  });

  it("still refuses a running project even with --anyway", () => {
    // The override is scoped to the verdict. It is not a general force flag.
    seed("running", new Date().toISOString());
    writePriorArt("p", noGap, env);
    expect(() => guardRunnable("p", env, { anyway: true })).toThrow(/already running/);
  });

  it("allows a clear_gap project", () => {
    seed("awaiting_human");
    writePriorArt("p", { verdict: "clear_gap", summary: "nothing does this", existing: [] }, env);
    expect(() => guardRunnable("p", env)).not.toThrow();
  });

  it("allows a project already past the verdict", () => {
    // After `--anyway` the file stays on disk; it must not re-block every later run.
    seed("awaiting_human", null, "clarify");
    writePriorArt("p", noGap, env);
    expect(() => guardRunnable("p", env)).not.toThrow();
  });

  it("refuses to run on a malformed PRIOR_ART.json rather than ignoring it", () => {
    // Deliberately the opposite of `sfo status`, which swallows so one bad
    // artifact cannot break the whole listing. A gate fails closed: the file
    // most likely to be garbled mid-write is the one saying "do not build
    // this", and silently ceasing to gate is the worst available outcome.
    seed("awaiting_human");
    fs.writeFileSync(path.join(env.SFO_HOME, "p", ".sfo", "PRIOR_ART.json"), "{ not json");
    expect(() => guardRunnable("p", env)).toThrow(/unreadable PRIOR_ART\.json/);
  });
});

describe("detachedArgs", () => {
  it("runs the child attached", () => {
    expect(detachedArgs("p")).toContain("--attach");
  });

  it("carries --anyway through to the child", () => {
    // The child re-runs guardRunnable. Without the flag it would refuse the
    // very verdict the parent just let the human override — and refuse it with
    // stdio: "ignore", so the user would see "started (pid N)" and nothing else.
    expect(detachedArgs("p", { anyway: true })).toContain("--anyway");
  });

  it("does not pass --anyway when the human did not ask for it", () => {
    expect(detachedArgs("p")).not.toContain("--anyway");
  });
});

describe("corrupt prior art fails closed", () => {
  function seedParkedAtResearch() {
    fs.mkdirSync(path.join(env.SFO_HOME, "p", ".sfo"), { recursive: true });
    writeState(
      {
        id: "p",
        title: "T",
        currentStage: "research",
        status: "awaiting_human",
        attempts: {},
        pid: null,
        heartbeatAt: null,
        createdAt: "2026-08-21T00:00:00.000Z",
        updatedAt: "2026-08-21T00:00:00.000Z",
      },
      env,
    );
  }

  it("refuses to run when the verdict cannot be read", () => {
    // The most likely file to garble is the one that said "do not build this",
    // so an unreadable verdict must block rather than silently stop gating.
    seedParkedAtResearch();
    fs.writeFileSync(path.join(env.SFO_HOME, "p", ".sfo", "PRIOR_ART.json"), "{ truncated");
    expect(() => guardRunnable("p", env)).toThrow(/unreadable PRIOR_ART\.json/);
  });

  it("still lets --anyway through a corrupt verdict", () => {
    seedParkedAtResearch();
    fs.writeFileSync(path.join(env.SFO_HOME, "p", ".sfo", "PRIOR_ART.json"), "{ truncated");
    expect(() => guardRunnable("p", env, { anyway: true })).not.toThrow();
  });

  it("is unaffected when there is no prior art at all", () => {
    seedParkedAtResearch();
    expect(() => guardRunnable("p", env)).not.toThrow();
  });
});

describe("guardRunnable and the budget ceiling", () => {
  const usage = {
    costUsd: 3, durationMs: 10, numTurns: 1,
    inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
  };

  function spend(dollars: number) {
    recordCost("p", "research", true, { ...usage, costUsd: dollars }, env);
  }

  it("refuses a project that has spent its ceiling", () => {
    // `sfo run` spawns a detached child with stdio: "ignore". Left to the
    // child, this refusal would print "started (pid N)" and then vanish.
    seed("awaiting_human");
    writeBudget("p", 5, env);
    spend(5);
    expect(() => guardRunnable("p", env)).toThrow(/budget ceiling/);
    expect(() => guardRunnable("p", env)).toThrow(/sfo budget p <usd>/);
  });

  it("refuses it even with --anyway, which is scoped to the prior-art verdict", () => {
    seed("awaiting_human");
    writeBudget("p", 5, env);
    spend(6);
    expect(() => guardRunnable("p", env, { anyway: true })).toThrow(/budget ceiling/);
  });

  it("allows a project still under its ceiling", () => {
    seed("awaiting_human");
    writeBudget("p", 5, env);
    spend(1);
    expect(() => guardRunnable("p", env)).not.toThrow();
  });

  it("allows a project with no ceiling, whatever it has spent", () => {
    seed("awaiting_human");
    spend(500);
    expect(() => guardRunnable("p", env)).not.toThrow();
  });
});

describe("model access in run", () => {
  it("carries --use-api-key through to the child", () => {
    expect(detachedArgs("p", { useApiKey: true })).toEqual(["run", "p", "--attach", "--use-api-key"]);
  });

  it("refuses before detaching when the chosen key cannot be found", () => {
    seed("awaiting_human", null, "spec");
    writeProfile(
      {
        modelAccess: ["anthropic_api_key"],
        apiKey: { source: "env", var: "SFO_TEST_NO_SUCH_KEY" },
        sfoPrefers: "anthropic_api_key",
        updatedAt: "2026-09-27T00:00:00.000Z",
      },
      env,
    );
    writeAccess("p", { modelAccess: ["anthropic_api_key"], sfoPrefers: "anthropic_api_key" }, env);
    expect(() => guardRunnable("p", env)).toThrow(/no API key found at env:SFO_TEST_NO_SUCH_KEY/);
  });

  it("refuses --use-api-key with no key anywhere", () => {
    seed("awaiting_human", null, "spec");
    expect(() => guardRunnable("p", env, { useApiKey: true })).toThrow(/no API key found/);
  });
});

describe("runnerFor", () => {
  const withFallback = (fallbackToApiKey: boolean, key: string | null) =>
    writeProfile(
      {
        modelAccess: ["claude_subscription", "anthropic_api_key"],
        apiKey: { source: "env", var: "SFO_TEST_FALLBACK_KEY" },
        sfoPrefers: "claude_subscription",
        fallbackToApiKey,
        updatedAt: "2026-09-27T00:00:00.000Z",
      },
      { ...env, ...(key ? { SFO_TEST_FALLBACK_KEY: key } : {}) },
    );

  it("wraps the plan in the fallback only when the person opted in", () => {
    const keyed = { ...env, SFO_TEST_FALLBACK_KEY: "sk" };

    withFallback(false, "sk");
    expect(runnerFor("p", { method: "claude_subscription" }, keyed)).not.toBeInstanceOf(FallbackRunner);

    withFallback(true, "sk");
    expect(runnerFor("p", { method: "claude_subscription" }, keyed)).toBeInstanceOf(FallbackRunner);
    expect(runnerFor("p", { method: "anthropic_api_key", apiKey: "sk" }, keyed)).not.toBeInstanceOf(
      FallbackRunner,
    );
  });

  it("runs on the plan alone, and says why, when the fallback's key is missing", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    withFallback(true, null);
    expect(runnerFor("p", { method: "claude_subscription" }, env)).not.toBeInstanceOf(FallbackRunner);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/fallback to the API key is on, but no API key found/));
    error.mockRestore();
  });
});

describe("recordCrash", () => {
  it("leaves the project resumable and says why it stopped", async () => {
    const { recordCrash } = await import("../../src/commands/run.js");
    const { listProjects, formatStatus } = await import("../../src/commands/status.js");
    seed("running", new Date().toISOString(), "research");
    recordCrash("p", new Error("invalid PRIOR_ART.json: recommendation expected string"), env);

    const { readState } = await import("../../src/core/state.js");
    expect(readState("p", env)).toMatchObject({ status: "awaiting_human", pid: null });
    expect(formatStatus(listProjects(env))).toMatch(/crashed in research: Error: invalid PRIOR_ART.json/);
  });
});
