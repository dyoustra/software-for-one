import { describe, it, expect } from "vitest";
import type { Project, ProjectSummary } from "../../src/api/types.js";
import { byAttention, cardModel, formatDuration, milestoneIndex, waitingOnYou } from "../../app/src/lib/pipeline.js";

function project(summary: Partial<ProjectSummary> | null, extra: Partial<Project> = {}): Project {
  return {
    id: "moon-abc123",
    sprite: "sfo-00000000",
    repo: null,
    status: "ready",
    summary: summary ? { id: "moon-abc123", title: "Moon", currentStage: "spec", status: "running", ...summary } : null,
    createdAt: "2026-11-11T00:00:00Z",
    updatedAt: "2026-11-11T00:00:00Z",
    ...extra,
  };
}

describe("the rail", () => {
  it("collapses the pipeline's stages into seven milestones", () => {
    expect(["capture", "research", "spec", "clarify", "plan", "test-write", "test-repair", "build", "smoke", "review", "deliver"].map(milestoneIndex)).toEqual([
      0, 0, 1, 2, 3, 3, 3, 4, 5, 5, 6,
    ]);
  });

  it("puts a stage it does not know at the start rather than nowhere", () => {
    expect(milestoneIndex("something-new")).toBe(0);
  });
});

describe("a project's card", () => {
  it("is waiting on you, parked, with the question count as its badge and a steady halo", () => {
    const m = cardModel(project({ status: "awaiting_human", currentStage: "clarify", openQuestions: 2, spendUsd: 0.18 }));
    expect(m).toMatchObject({ kind: "waiting", badge: { tone: "waiting", text: "2 questions" }, rail: { at: 2, halo: "steady" }, spend: "$0.18", time: "Parked" });
  });

  it("a close prior-art match is the person's call, not a terminal command", () => {
    const m = cardModel(project({ status: "awaiting_human", currentStage: "research", note: "prior art is close — `sfo why x` to decide" }));
    expect(m).toMatchObject({ kind: "waiting", badge: { text: "Your call" }, line: "Something close already exists" });
  });

  it("waiting without questions says what it waits for", () => {
    const m = cardModel(project({ status: "awaiting_human", currentStage: "research", note: "stopped: use shuf instead" }));
    expect(m).toMatchObject({ kind: "waiting", badge: { text: "Needs you" }, line: "stopped: use shuf instead" });
  });

  it("is running, saying what it is doing, with slices once planned and a breathing halo", () => {
    const m = cardModel(project({ status: "running", currentStage: "build", slicesTotal: 5, slicesPassed: ["S-01", "S-02", "S-03"], spendUsd: 1.4, computeMs: 14 * 60_000 }));
    expect(m).toMatchObject({ kind: "running", badge: { text: "Building" }, rail: { at: 4, tone: "running", halo: "breathing" }, slices: { passed: 3, total: 5 }, time: "14m" });
  });

  it("failed: the rail stops red where it failed, with the reason in place of slices", () => {
    const m = cardModel(project({ status: "failed", currentStage: "review", failure: { stage: "review", reason: "two findings left open" } }));
    expect(m).toMatchObject({ kind: "failed", badge: { tone: "failed", text: "Failed at Verify" }, rail: { at: 5, tone: "failed", halo: "none" }, line: "two findings left open" });
    expect(m.slices).toBeUndefined();
  });

  it("finished: no rail, the commands it installed, quietly marked done", () => {
    const m = cardModel(project({ status: "done", currentStage: "deliver", delivered: { commands: ["rolld"] } }));
    expect(m).toMatchObject({ kind: "done", badge: { tone: "done", text: "✓ CLI" }, line: "rolld", lineIsCode: true });
    expect(m.rail).toBeUndefined();
  });

  it("finished with something unresolved says so in amber, and what it is", () => {
    const m = cardModel(project({ status: "done", note: "done, but smoke found 1 problem" }));
    expect(m.badge).toEqual({ tone: "waiting", text: "Done, with notes" });
    expect(m).toMatchObject({ line: "done, but smoke found 1 problem", lineIsCode: false });
  });

  it("finished without installing anything points at its repo", () => {
    expect(cardModel(project({ status: "done" }, { repo: "github.com/dyoustra/moon-abc123" }))).toMatchObject({ line: "dyoustra/moon-abc123", lineIsCode: true });
  });

  it("setting up: the idea as its title and the step under way, or why setup failed", () => {
    expect(cardModel(project(null, { status: "creating", idea: "a dice roller\nwith advantage", setup: { step: "Reading your idea", error: null } }))).toMatchObject({
      kind: "setup",
      title: "a dice roller",
      line: "Reading your idea",
      rail: { at: -1 },
    });
    expect(cardModel(project(null, { status: "creating", idea: "x", setup: { step: null, error: "no network" } }))).toMatchObject({ kind: "failed", badge: { text: "Setup failed" }, line: "no network" });
  });

  it("reads a summary from an older Sprite, without telemetry, without inventing any", () => {
    const m = cardModel(project({ status: "running", currentStage: "plan" }));
    expect(m.spend).toBeUndefined();
    expect(m.time).toBeUndefined();
    expect(m.slices).toBeUndefined();
  });
});

describe("ordering", () => {
  const at = (updatedAt: string, summary: Partial<ProjectSummary> | null, extra: Partial<Project> = {}) => project(summary, { updatedAt, ...extra, id: `${summary?.status ?? "setup"}-${updatedAt}` });

  it("puts what needs you first and finished work last", () => {
    const list = [at("1", { status: "done" }), at("2", { status: "running" }), at("3", { status: "failed" }), at("4", { status: "awaiting_human" }), at("5", null, { status: "creating", setup: { step: "x", error: null } })];
    expect(byAttention(list).map((p) => cardModel(p).kind)).toEqual(["waiting", "setup", "running", "failed", "done"]);
  });

  it("names the run that has waited longest first", () => {
    expect(waitingOnYou([at("2026-11-11T10", { status: "awaiting_human" }), at("2026-11-11T08", { status: "awaiting_human" }), at("2026-11-11T09", { status: "running" })]).map((p) => p.updatedAt)).toEqual([
      "2026-11-11T08",
      "2026-11-11T10",
    ]);
  });
});

describe("durations", () => {
  it("read as a person would say them", () => {
    expect([20_000, 14 * 60_000, 72 * 60_000].map(formatDuration)).toEqual(["20s", "14m", "1h 12m"]);
  });
});
