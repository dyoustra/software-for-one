import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listProjects, formatStatus } from "../../src/commands/status.js";
import { writeState } from "../../src/core/state.js";
import { writePriorArt, type PriorArt } from "../../src/core/priorart.js";
import { writeBudget } from "../../src/core/budget.js";
import { recordCost } from "../../src/core/cost.js";

let env: Record<string, string>;

function seed(id: string, stage: string, status: "running" | "awaiting_human" | "failed" | "done") {
  fs.mkdirSync(path.join(env.SFO_HOME, id, ".sfo"), { recursive: true });
  writeState(
    {
      id,
      title: id,
      currentStage: stage,
      status,
      attempts: {},
      pid: null,
      heartbeatAt: null,
      createdAt: "2026-08-21T00:00:00.000Z",
      updatedAt: "2026-08-21T00:00:00.000Z",
    },
    env,
  );
}

function seedPriorArt(id: string, art: PriorArt) {
  fs.mkdirSync(path.join(env.SFO_HOME, id, ".sfo"), { recursive: true });
  writePriorArt(id, art, env);
}

const noGap: PriorArt = {
  verdict: "no_gap",
  summary: "ai-renamer does this already.",
  existing: [{ name: "ai-renamer", url: "https://example.com", gap: "none worth the build" }],
  recommendation: "use ai-renamer instead",
};

beforeEach(() => {
  env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-st-")) };
});

describe("listProjects", () => {
  it("returns an empty list when nothing exists", () => {
    expect(listProjects(env)).toEqual([]);
  });

  it("lists every project", () => {
    seed("a-111", "spec", "running");
    seed("b-222", "clarify", "awaiting_human");
    expect(listProjects(env).map((p) => p.id).sort()).toEqual(["a-111", "b-222"]);
  });

  it("skips directories with no state file", () => {
    seed("a-111", "spec", "running");
    fs.mkdirSync(path.join(env.SFO_HOME, "junk"), { recursive: true });
    expect(listProjects(env)).toHaveLength(1);
  });

  it("notes the recommendation when prior art stopped the project", () => {
    seed("a-111", "research", "awaiting_human");
    seedPriorArt("a-111", noGap);
    expect(listProjects(env)[0]?.note).toBe("stopped: use ai-renamer instead");
  });

  it("notes a marginal verdict as a decision the human owes", () => {
    seed("a-111", "research", "awaiting_human");
    seedPriorArt("a-111", { verdict: "marginal_gap", summary: "close", existing: [] });
    expect(listProjects(env)[0]?.note).toMatch(/prior art is close/);
  });

  it("leaves a project with a clear gap unannotated", () => {
    seed("a-111", "clarify", "awaiting_human");
    seedPriorArt("a-111", { verdict: "clear_gap", summary: "nothing does this", existing: [] });
    expect(listProjects(env)[0]?.note).toBeUndefined();
  });

  it("leaves a project with no prior art unannotated", () => {
    seed("a-111", "clarify", "awaiting_human");
    expect(listProjects(env)[0]?.note).toBeUndefined();
  });

  it("does not note a project that is past the verdict and running again", () => {
    // `--anyway` leaves PRIOR_ART.json on disk, so the file alone cannot mean
    // "stopped here" — the project has to actually be parked at research.
    seed("a-111", "spec", "running");
    seedPriorArt("a-111", noGap);
    expect(listProjects(env)[0]?.note).toBeUndefined();
  });

  it("still lists a project whose PRIOR_ART.json is malformed", () => {
    seed("a-111", "research", "awaiting_human");
    fs.writeFileSync(path.join(env.SFO_HOME, "a-111", ".sfo", "PRIOR_ART.json"), "{ not json");
    const listed = listProjects(env);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.note).toBeUndefined();
  });
});

describe("formatStatus", () => {
  it("flags a project that needs the human", () => {
    seed("b-222", "clarify", "awaiting_human");
    expect(formatStatus(listProjects(env))).toContain("needs you");
  });

  it("reports a stale running project rather than claiming it is live", () => {
    seed("c-333", "spec", "running");
    expect(formatStatus(listProjects(env))).toContain("stale");
  });

  it("shows the note in place of the bare needs-you label", () => {
    seed("b-222", "research", "awaiting_human");
    seedPriorArt("b-222", noGap);
    const out = formatStatus(listProjects(env));
    expect(out).toContain("stopped: use ai-renamer instead");
    expect(out).not.toContain("needs you");
  });

  it("truncates a runaway recommendation instead of wrecking the table", () => {
    seed("b-222", "research", "awaiting_human");
    seedPriorArt("b-222", { ...noGap, recommendation: "x".repeat(400) });
    const line = formatStatus(listProjects(env));
    expect(line.length).toBeLessThan(160);
    expect(line).toContain("…");
  });
});

describe("the budget note", () => {
  const usage = {
    costUsd: 6, durationMs: 10, numTurns: 1,
    inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
  };

  it("says the project is out of money rather than that it needs an answer", () => {
    seed("a-111", "clarify", "awaiting_human");
    writeBudget("a-111", 5, env);
    recordCost("a-111", "spec", true, usage, env);

    const out = formatStatus(listProjects(env));
    expect(out).toContain("over budget ($6.00 of $5.00)");
    expect(out).not.toContain("needs you");
  });

  it("clears as soon as the ceiling is raised", () => {
    seed("a-111", "clarify", "awaiting_human");
    writeBudget("a-111", 5, env);
    recordCost("a-111", "spec", true, usage, env);
    writeBudget("a-111", 50, env);

    expect(listProjects(env)[0]?.note).toBeUndefined();
  });

  it("leaves the prior-art verdict in front, since that one can end the project", () => {
    seed("a-111", "research", "awaiting_human");
    seedPriorArt("a-111", noGap);
    writeBudget("a-111", 5, env);
    recordCost("a-111", "research", true, usage, env);

    expect(listProjects(env)[0]?.note).toBe("stopped: use ai-renamer instead");
  });

  it("does not annotate a project that is not parked", () => {
    seed("a-111", "spec", "running");
    writeBudget("a-111", 5, env);
    recordCost("a-111", "spec", true, usage, env);

    expect(listProjects(env)[0]?.note).toBeUndefined();
  });

  it("survives a malformed BUDGET.json instead of dropping the project", () => {
    // `sfo status` lists everything or it is useless; the gates in `advance`
    // and `guardRunnable` are where a bad ceiling fails closed.
    seed("a-111", "clarify", "awaiting_human");
    fs.writeFileSync(path.join(env.SFO_HOME, "a-111", ".sfo", "BUDGET.json"), "{ not json");
    const listed = listProjects(env);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.note).toBeUndefined();
  });
});

describe("a delivered project whose seams failed", () => {
  it("says which, instead of plain done", () => {
    seed("p", "deliver", "done");
    const line = (seam: string, level: string, attempt: number) =>
      JSON.stringify({ seam, check: "c", level, detail: "", attempt, at: `2026-09-27T00:0${attempt}:00.000Z` });
    fs.writeFileSync(
      path.join(env.SFO_HOME, "p", ".sfo", "SMOKE.jsonl"),
      [
        line("anthropic-batch", "failed", 1),
        line("anthropic-batch", "failed", 2),
        line("vision-ocr", "failed", 1),
        line("vision-ocr", "completed", 2),
      ].join("\n") + "\n",
    );
    expect(formatStatus(listProjects(env))).toMatch(/done, but failed against the real thing: anthropic-batch$/m);
  });
});

describe("a delivered project with unrepaired review findings", () => {
  it("counts the high ones that are still true", () => {
    seed("p", "deliver", "done");
    const f = (id: string, severity: string, status: string) =>
      JSON.stringify({ id, round: 1, severity, kind: "code", summary: "s", evidence: "e", status, test: `tests/review/test_${id}.py` });
    fs.writeFileSync(
      path.join(env.SFO_HOME, "p", ".sfo", "FINDINGS.jsonl"),
      [f("R-001", "high", "unrepaired"), f("R-002", "high", "repaired"), f("R-003", "medium", "unrepaired")].join("\n") + "\n",
    );
    const out = formatStatus(listProjects(env));
    expect(out).toMatch(/done, but 1 high review finding unresolved$/m);
    expect(out).toMatch(/→ `sfo retry p` retries what failed/);
  });
});

describe("round 2's findings", () => {
  it("count as unresolved when high, since round 2 repairs nothing", () => {
    seed("p", "deliver", "done");
    const f = (id: string, round: number, status: string) =>
      JSON.stringify({ id, round, severity: "high", kind: "code", summary: "s", evidence: "e", status });
    fs.writeFileSync(
      path.join(env.SFO_HOME, "p", ".sfo", "FINDINGS.jsonl"),
      [f("R-001", 1, "repaired"), f("R-016", 2, "report_only"), f("R-017", 2, "report_only")].join("\n") + "\n",
    );
    expect(formatStatus(listProjects(env))).toMatch(/done, but 2 high review findings unresolved/);
  });
});

describe("the next step", () => {
  it("names the command for a failure and for open questions", () => {
    seed("a", "research", "failed");
    seed("b", "clarify", "awaiting_human");
    fs.writeFileSync(
      path.join(env.SFO_HOME, "b", ".sfo", "QUESTIONS.json"),
      JSON.stringify({ questions: [{ id: "Q-001", section: "blocking", text: "t", context: "c", options: [{ key: "A", label: "a", tradeoff: "x" }, { key: "B", label: "b", tradeoff: "y" }] }] }),
    );
    const out = formatStatus(listProjects(env));
    expect(out).toMatch(/→ .*sfo stage a research/);
    expect(out).toMatch(/→ `sfo answer b`/);
  });
});

describe("a finding only feedback can fix", () => {
  it("points at sfo feedback, not a retry that could do nothing", () => {
    seed("p", "deliver", "done");
    fs.writeFileSync(
      path.join(env.SFO_HOME, "p", ".sfo", "FINDINGS.jsonl"),
      JSON.stringify({ id: "R-009", round: 2, severity: "high", kind: "code", summary: "s", evidence: "e", status: "report_only" }) + "\n",
    );
    const out = formatStatus(listProjects(env));
    expect(out).toMatch(/→ `sfo feedback p "…"` to fix R-009/);
    expect(out).not.toMatch(/sfo retry/);
  });
});

