import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { guardRunnable, detachedArgs } from "../../src/commands/run.js";
import { writeState, type ProjectState } from "../../src/core/state.js";
import { writePriorArt, type PriorArt } from "../../src/core/priorart.js";

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

  it("does not choke on a malformed PRIOR_ART.json", () => {
    seed("awaiting_human");
    fs.writeFileSync(path.join(env.SFO_HOME, "p", ".sfo", "PRIOR_ART.json"), "{ not json");
    expect(() => guardRunnable("p", env)).not.toThrow();
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
