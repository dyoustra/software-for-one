import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { addFeedback, readFeedback, runFeedback, type FeedbackContext } from "../../src/core/feedback.js";
import { writeState } from "../../src/core/state.js";
import { writeSlices } from "../../src/core/slices.js";
import { writeCriteria, readCriteria } from "../../src/core/criteria.js";
import { lockTests, readTestLock } from "../../src/core/testlock.js";
import { readDecisions } from "../../src/core/decisions.js";
import type { Runner, RunStageInput, StageResult } from "../../src/runner/types.js";
import type { VerifyResult } from "../../src/core/verify.js";

let env: Record<string, string>;
let dir: string;
const PASS: VerifyResult = { ok: true, steps: [], tamperedTests: [] };

function git(...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, encoding: "utf8", stdio: "pipe" });
}
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};

beforeEach(() => {
  env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-feedback-")) };
  dir = path.join(env.SFO_HOME, "p");
  write("tests/test_s01.py", "def test_s01() -> None: pass\n");
  write("tower.py", "ART = 'a stick'\n");
  write(".sfo/SUMMARY.md", "# ut-tower\n\nIt works.\n");
  writeSlices("p", [{ id: "S-01", name: "one", criterionIds: ["AC-001"], prerequisites: [] }], env);
  writeCriteria("p", [{ id: "AC-001", group: "Art", text: "The tower is drawn." }], env);
  writeState(
    { id: "p", title: "T", currentStage: "deliver", status: "done", attempts: {}, slicesPassed: ["S-01"], pid: null, heartbeatAt: null, createdAt: "2026-09-29T00:00:00.000Z", updatedAt: "2026-09-29T00:00:00.000Z" },
    env,
  );
  lockTests("p", "tests", env);
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "delivered");
});

class Agent implements Runner {
  calls: RunStageInput[] = [];
  constructor(private readonly onRun: (call: number) => void) {}
  async runStage(input: RunStageInput): Promise<StageResult> {
    this.calls.push(input);
    this.onRun(this.calls.length);
    return { ok: true, exitCode: 0, logPath: input.logPath };
  }
}

function ctx(runner: Runner, over: Partial<FeedbackContext> = {}): FeedbackContext & { after: number } {
  const c = {
    id: "p",
    env,
    runner,
    archetype: "cli-python",
    verify: () => PASS,
    suiteCheck: () => PASS,
    passedGate: () => PASS,
    withHeartbeat: <T,>(fn: () => Promise<T>) => fn(),
    after: 0,
    afterwards: () => {
      c.after++;
    },
    ...over,
  };
  return c;
}

const result = (verdict: string, summary: string) => write(".sfo/FEEDBACK_RESULT.json", JSON.stringify({ verdict, summary }));

describe("runFeedback", () => {
  it("applies the change, locks its new test, records the criteria as the person's, and reinstalls", async () => {
    const n = addFeedback("p", "it looks nothing like the real tower", env).n;
    const agent = new Agent(() => {
      write("tower.py", "ART = 'the real tower'\n");
      write("tests/test_feedback_tower.py", "def test_shape() -> None: pass\n");
      writeCriteria("p", [{ id: "AC-001", group: "Art", text: "The tower is drawn as the real UT Tower's silhouette." }], env);
      result("done", "Redrew the tower from the photos.");
    });
    const c = ctx(agent);
    const out = await runFeedback(c, n);

    expect(out).toEqual({ outcome: "done", summary: "Redrew the tower from the photos." });
    expect(agent.calls[0].prompt).toContain("it looks nothing like the real tower");
    expect(Object.keys(readTestLock("p", env))).toContain("tests/test_feedback_tower.py");
    expect(readDecisions("p", env).find((d) => d.id === "D-feedback-1")).toMatchObject({ decided_by: "human", chose: expect.stringMatching(/reworded AC-001/) });
    expect(fs.readFileSync(path.join(dir, ".sfo/SUMMARY.md"), "utf8")).toMatch(/## Changes after delivery[\s\S]*> it looks nothing like the real tower[\s\S]*Redrew the tower/);
    expect(readFeedback("p", env)[0].status).toBe("done");
    expect(git("log", "--format=%s", "-1")).toMatch(/^stage\(feedback-1\)/);
    expect(c.after).toBe(1);
  });

  it("never lets it edit a locked test, and gives the next attempt the reason", async () => {
    const n = addFeedback("p", "change it", env).n;
    const agent = new Agent(() => write("tests/test_s01.py", "def test_s01() -> None: assert True\n"));
    const out = await runFeedback(ctx(agent), n);

    expect(out.outcome).toBe("failed");
    expect(agent.calls[1].prompt).toMatch(/changed tests that were already locked: tests\/test_s01.py/);
    expect(fs.readFileSync(path.join(dir, "tests/test_s01.py"), "utf8")).toBe("def test_s01() -> None: pass\n");
  });

  it("discards everything, criteria included, when the gate fails twice", async () => {
    const n = addFeedback("p", "change it", env).n;
    const agent = new Agent(() => {
      write("tower.py", "ART = broken\n");
      writeCriteria("p", [{ id: "AC-001", group: "Art", text: "changed" }], env);
    });
    const out = await runFeedback(ctx(agent, { passedGate: () => ({ ok: false, steps: [{ name: "test", ok: false, exitCode: 1, output: "FAILED test_s01" }], tamperedTests: [], reason: "test failed" }) }), n);

    expect(out.outcome).toBe("failed");
    expect(agent.calls[1].prompt).toMatch(/previous attempt failed the gate[\s\S]*FAILED test_s01/);
    expect(fs.readFileSync(path.join(dir, "tower.py"), "utf8")).toBe("ART = 'a stick'\n");
    expect(readCriteria("p", env)[0].text).toBe("The tower is drawn.");
    expect(readFeedback("p", env)[0]).toMatchObject({ status: "failed", reason: expect.stringMatching(/failed the gate 2 times/) });
  });

  it("changes nothing when the agent says it is too big for a follow-up", async () => {
    const n = addFeedback("p", "make it a web app", env).n;
    const agent = new Agent(() => {
      write("tower.py", "half a rewrite\n");
      result("too_big", "This needs a web server and a new archetype.");
    });
    const c = ctx(agent);
    const out = await runFeedback(c, n);

    expect(out).toEqual({ outcome: "too_big", summary: "This needs a web server and a new archetype." });
    expect(fs.readFileSync(path.join(dir, "tower.py"), "utf8")).toBe("ART = 'a stick'\n");
    expect(c.after).toBe(0);
  });
});
