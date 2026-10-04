import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  planSmoke,
  resolveSeamCredential,
  runSmoke,
  readSmokeRecords,
  latestSmoke,
  type SeamProcess,
  type SmokeContext,
} from "../../src/core/smoke.js";
import { writeState } from "../../src/core/state.js";
import { writeSlices } from "../../src/core/slices.js";
import { lockTests } from "../../src/core/testlock.js";
import { writeSmokeCap } from "../../src/core/budget.js";
import { readCostRecords } from "../../src/core/cost.js";
import { writeProfile } from "../../src/core/access.js";
import { writeCredentials, type Service } from "../../src/core/services.js";
import type { Runner, RunStageInput, StageResult } from "../../src/runner/types.js";

let env: Record<string, string>;
let dir: string;

const seam = (over: Partial<Service> = {}): Service => ({
  id: "anthropic-batch",
  name: "Anthropic Message Batches API",
  kind: "network",
  effect: "billed",
  testMode: null,
  credential: { name: "ANTHROPIC_API_KEY", covers: "anthropic_api_key" },
  constraints: [{ rule: "custom_id is at most 64 characters", source: "https://docs.anthropic.com/x" }],
  smoke: { checks: ["submit a one-request batch"], maxCostUsd: 0.01, async: true },
  ...over,
});

const OCR = seam({
  id: "vision-ocr",
  name: "macOS Vision OCR",
  kind: "platform",
  effect: "read_only",
  credential: null,
  constraints: [],
  smoke: { checks: ["read known text from a rendered PNG"], maxCostUsd: 0, async: false },
});

function git(...args: string[]): void {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, stdio: "pipe" });
}

/** A built project: slices passed, smoke files for the given seams, locked and committed. */
function project(services: Service[], files: string[] = services.map((s) => `smoke/test_smoke_${s.id.replace(/-/g, "_")}.py`)): void {
  fs.mkdirSync(path.join(dir, ".sfo"), { recursive: true });
  fs.mkdirSync(path.join(dir, "smoke"), { recursive: true });
  fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
  fs.writeFileSync(path.join(dir, "tests", "test_s01.py"), "def test_s01(): pass\n");
  for (const f of files) fs.writeFileSync(path.join(dir, f), "def test_it(): pass\n");
  fs.writeFileSync(path.join(dir, ".sfo", "SERVICES.jsonl"), services.map((s) => JSON.stringify(s)).join("\n") + "\n");
  writeSlices("p", [{ id: "S-01", name: "one", criterionIds: ["AC-001"], prerequisites: [] }], env);
  writeState(
    {
      id: "p",
      title: "T",
      currentStage: "smoke",
      status: "running",
      attempts: {},
      slicesPassed: ["S-01"],
      pid: null,
      heartbeatAt: null,
      createdAt: "2026-09-27T00:00:00.000Z",
      updatedAt: "2026-09-27T00:00:00.000Z",
    },
    env,
  );
  fs.writeFileSync(path.join(dir, "src.py"), "x = 1\n");
  lockTests("p", "tests", env);
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "built");
}

const keyring = () => "sk-test";

beforeEach(() => {
  env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-smoke-")) };
  dir = path.join(env.SFO_HOME, "p");
  fs.mkdirSync(dir, { recursive: true });
  writeProfile(
    {
      modelAccess: ["claude_subscription", "anthropic_api_key"],
      apiKey: { source: "keychain", service: "anthropic-api-key" },
      sfoPrefers: "claude_subscription",
      updatedAt: "2026-09-27T00:00:00.000Z",
    },
    env,
  );
});

/** Stands in for the smoke runner: writes what each seam's script says, exits as told. */
function seams(script: Record<string, (attempt: number) => { lines: object[]; exit: number }>): SeamProcess & { envs: Record<string, string | undefined>[] } {
  const counts: Record<string, number> = {};
  const envs: Record<string, string | undefined>[] = [];
  const fn: SeamProcess = async ({ args, env: childEnv }) => {
    envs.push(childEnv);
    const file = args.at(-1) ?? "";
    const id = Object.keys(script).find((k) => file.includes(k.replace(/-/g, "_")));
    if (!id) return { exitCode: 5, output: "no tests ran", timedOut: false };
    counts[id] = (counts[id] ?? 0) + 1;
    const { lines, exit } = script[id](counts[id]);
    fs.writeFileSync(childEnv.SFO_SMOKE_RESULTS ?? "", lines.map((l) => JSON.stringify(l)).join("\n"));
    return { exitCode: exit, output: exit === 0 ? "1 passed" : "E   BadRequestError: custom_id too long", timedOut: false };
  };
  return Object.assign(fn, { envs });
}

class RepairRunner implements Runner {
  calls: RunStageInput[] = [];
  constructor(private readonly onRun: (stage: string) => void = () => {}) {}
  async runStage(input: RunStageInput): Promise<StageResult> {
    this.calls.push(input);
    this.onRun(path.basename(input.logPath, ".log"));
    return { ok: true, exitCode: 0, logPath: input.logPath, usage: { costUsd: 0.5, durationMs: 1, numTurns: 1, inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, billing: "plan" };
  }
}

function context(runner: Runner, spawnSeam: SeamProcess, over: Partial<SmokeContext> = {}): SmokeContext {
  return {
    id: "p",
    env,
    runner,
    archetype: "cli-python",
    verify: () => ({ ok: true, steps: [], tamperedTests: [] }),
    suiteCheck: () => ({ ok: true, steps: [], tamperedTests: [] }),
    passedGate: () => ({ ok: true, steps: [], tamperedTests: [] }),
    budgetExceeded: () => false,
    withHeartbeat: (fn) => fn(),
    deps: { spawnSeam, readKeyWith: keyring },
    ...over,
  };
}

const ok = (level = "completed", costUsd?: number) => () => ({
  lines: [{ seam: "x", check: "c", level, detail: "fine", ...(costUsd !== undefined ? { costUsd } : {}) }],
  exit: 0,
});

describe("planSmoke", () => {
  const exists = () => {
    fs.mkdirSync(path.join(dir, "smoke"), { recursive: true });
  };

  it("never runs an irreversible seam without a test mode", () => {
    exists();
    const send = seam({ id: "send-email", effect: "irreversible", credential: null });
    fs.writeFileSync(path.join(dir, "smoke/test_smoke_send_email.py"), "");
    const plan = planSmoke([send], "cli-python", dir, 2, () => ({ ok: true, env: {} }));
    expect(plan.run).toEqual([]);
    expect(plan.skipped[0].detail).toMatch(/irreversible, and the service has no test mode/);

    const withTestMode = planSmoke([{ ...send, testMode: "sandbox domain" }], "cli-python", dir, 2, () => ({ ok: true, env: {} }));
    expect(withTestMode.run).toHaveLength(1);
  });

  it("chooses seams in order until the next would pass the cap", () => {
    exists();
    const a = seam({ id: "a", smoke: { checks: ["c"], maxCostUsd: 1.5, async: false } });
    const b = seam({ id: "b", smoke: { checks: ["c"], maxCostUsd: 1, async: false } });
    const c = seam({ id: "c", smoke: { checks: ["c"], maxCostUsd: 0.5, async: false } });
    for (const s of ["a", "b", "c"]) fs.writeFileSync(path.join(dir, `smoke/test_smoke_${s}.py`), "");
    const plan = planSmoke([a, b, c], "cli-python", dir, 2, () => ({ ok: true, env: {} }));
    expect(plan.run.map((r) => r.service.id)).toEqual(["a", "c"]);
    expect(plan.skipped).toMatchObject([{ seam: "b", detail: expect.stringMatching(/over the \$2.00 smoke cap/) }]);
  });

  it("reports a seam nobody wrote a smoke test for", () => {
    exists();
    const plan = planSmoke([seam()], "cli-python", dir, 2, () => ({ ok: true, env: {} }));
    expect(plan.skipped[0].detail).toMatch(/no smoke test was written/);
  });
});

describe("resolveSeamCredential", () => {
  const profile = {
    modelAccess: ["claude_subscription" as const],
    apiKey: { source: "env" as const, var: "MY_KEY" },
    sfoPrefers: "claude_subscription" as const,
    fallbackToApiKey: false,
    subscriptionToken: null,
    githubToken: null,
    updatedAt: "",
  };

  it("supplies a covered key through the profile's reference", () => {
    expect(resolveSeamCredential(seam(), profile, {}, { MY_KEY: "sk" })).toEqual({ ok: true, env: { ANTHROPIC_API_KEY: "sk" } });
  });

  it("supplies an uncovered credential through the project's reference, and names a missing one", () => {
    const gh = seam({ credential: { name: "GITHUB_TOKEN", covers: null } });
    expect(resolveSeamCredential(gh, profile, { GITHUB_TOKEN: { source: "env", var: "GH" } }, { GH: "ghp" })).toEqual({
      ok: true,
      env: { GITHUB_TOKEN: "ghp" },
    });
    expect(resolveSeamCredential(gh, profile, {}, {})).toMatchObject({ ok: false, why: expect.stringMatching(/no reference to GITHUB_TOKEN/) });
    expect(resolveSeamCredential(gh, profile, { GITHUB_TOKEN: { source: "env", var: "GH" } }, {})).toMatchObject({
      ok: false,
      why: "GITHUB_TOKEN not found at env:GH",
    });
  });
});

describe("runSmoke", () => {
  it("does nothing for a project with no seams listed", async () => {
    fs.mkdirSync(path.join(dir, ".sfo"), { recursive: true });
    const out = await runSmoke(context(new RepairRunner(), seams({})));
    expect(out).toEqual({ outcome: "complete" });
    expect(readSmokeRecords("p", env)).toEqual([]);
  });

  it("records each seam's result, and passes each process its own credential only", async () => {
    project([seam(), OCR]);
    const spawn = seams({ "anthropic-batch": ok("accepted", 0.002), "vision-ocr": ok() });
    const before = process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.ANTHROPIC_AUTH_TOKEN = "sfo-own-token";
    try {
      await runSmoke(context(new RepairRunner(), spawn));
    } finally {
      if (before === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
      else process.env.ANTHROPIC_AUTH_TOKEN = before;
    }

    expect(latestSmoke(readSmokeRecords("p", env)).map((r) => [r.seam, r.level])).toEqual([
      ["anthropic-batch", "accepted"],
      ["vision-ocr", "completed"],
    ]);
    expect(spawn.envs[0].ANTHROPIC_API_KEY).toBe("sk-test");
    expect(spawn.envs[0].ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(spawn.envs[1].ANTHROPIC_API_KEY).toBeUndefined();
    const smokeCost = readCostRecords("p", env).find((r) => r.stage === "smoke");
    expect(smokeCost?.usage.costUsd).toBe(0.002);
    expect(smokeCost?.billing).toBe("api");
  });

  it("never writes a credential into the record", async () => {
    project([seam()]);
    await runSmoke(context(new RepairRunner(), seams({ "anthropic-batch": ok() })));
    expect(fs.readFileSync(path.join(dir, ".sfo", "SMOKE.jsonl"), "utf8")).not.toContain("sk-test");
  });

  it("counts a test that raised as failed, whatever it reported first", async () => {
    project([seam()]);
    const spawn = seams({
      "anthropic-batch": () => ({ lines: [{ seam: "x", check: "submit", level: "accepted", detail: "sent" }], exit: 1 }),
    });
    await runSmoke(context(new RepairRunner(), spawn, { passedGate: () => ({ ok: false, steps: [], tamperedTests: [], reason: "no" }) }));
    const [first] = readSmokeRecords("p", env);
    expect(first.level).toBe("failed");
    expect(first.detail).toMatch(/sent — then exited 1[\s\S]*custom_id too long/);
  });

  it("refuses a smoke suite that changed after the lock", async () => {
    project([seam()]);
    fs.writeFileSync(path.join(dir, "smoke/test_smoke_anthropic_batch.py"), "def test_it(): assert True\n");
    const out = await runSmoke(context(new RepairRunner(), seams({ "anthropic-batch": ok() })));
    expect(out).toMatchObject({ outcome: "failed", reason: expect.stringMatching(/changed since it was locked/) });
  });

  it("repairs a failed seam, keeps the fix that passes the gate, and re-runs only that seam", async () => {
    project([seam(), OCR]);
    const spawn = seams({
      "anthropic-batch": (n) => (n === 1 ? { lines: [], exit: 1 } : ok("completed")()),
      "vision-ocr": ok(),
    });
    const runner = new RepairRunner(() => fs.writeFileSync(path.join(dir, "src.py"), "x = 2\n"));
    await runSmoke(context(runner, spawn));

    expect(runner.calls.map((c) => path.basename(c.logPath, ".log"))).toEqual(["smoke-repair"]);
    expect(runner.calls[0].prompt).toContain("custom_id too long");
    const records = readSmokeRecords("p", env);
    expect(records.filter((r) => r.attempt === 2).map((r) => r.seam)).toEqual(["anthropic-batch"]);
    expect(latestSmoke(records).every((r) => r.level === "completed")).toBe(true);
    const log = execFileSync("git", ["log", "--format=%s"], { cwd: dir, encoding: "utf8" });
    expect(log).toMatch(/stage\(smoke-repair\)/);
  });

  it("discards a repair that breaks a built slice, and tells the next attempt why", async () => {
    project([seam()]);
    const spawn = seams({ "anthropic-batch": () => ({ lines: [], exit: 1 }) });
    const runner = new RepairRunner(() => fs.writeFileSync(path.join(dir, "src.py"), "x = broken\n"));
    await runSmoke(
      context(runner, spawn, {
        passedGate: () => ({
          ok: false,
          steps: [{ name: "test", ok: false, exitCode: 1, output: "FAILED tests/test_s01.py" }],
          tamperedTests: [],
          reason: "test failed",
        }),
      }),
    );

    expect(fs.readFileSync(path.join(dir, "src.py"), "utf8")).toBe("x = 1\n");
    // Two repairs, then the smoke test itself goes to the adjudicator.
    expect(runner.calls.map((c) => path.basename(c.logPath, ".log"))).toEqual(["smoke-repair", "smoke-repair", "adjudicate-SMOKE-anthropic-batch"]);
    expect(runner.calls[1].prompt).toMatch(/previous repair failed the gate[\s\S]*FAILED tests\/test_s01.py/);
  });

  it("gives up after two repairs and completes anyway, so deliver can report it", async () => {
    project([seam()]);
    const runner = new RepairRunner();
    const out = await runSmoke(context(runner, seams({ "anthropic-batch": () => ({ lines: [], exit: 1 }) })));
    expect(out).toEqual({ outcome: "complete" });
    expect(runner.calls.map((c) => path.basename(c.logPath, ".log"))).toEqual(["smoke-repair", "smoke-repair", "adjudicate-SMOKE-anthropic-batch"]);
    expect(latestSmoke(readSmokeRecords("p", env))[0].level).toBe("failed");
  });

  it("stops before a repair when the budget is spent", async () => {
    project([seam()]);
    const runner = new RepairRunner();
    const out = await runSmoke(
      context(runner, seams({ "anthropic-batch": () => ({ lines: [], exit: 1 }) }), { budgetExceeded: () => true }),
    );
    expect(out).toEqual({ outcome: "budget", stage: "smoke-repair" });
    expect(runner.calls).toHaveLength(0);
  });

  it("skips what the cap cannot cover, including everything at a cap of zero with a cost", async () => {
    project([seam(), OCR]);
    writeSmokeCap("p", 0, env);
    await runSmoke(context(new RepairRunner(), seams({ "anthropic-batch": ok(), "vision-ocr": ok() })));
    const levels = Object.fromEntries(latestSmoke(readSmokeRecords("p", env)).map((r) => [r.seam, r.level]));
    expect(levels).toEqual({ "anthropic-batch": "skipped", "vision-ocr": "completed" });
  });

  it("lets the repair contest a smoke test once, under the SMOKE id", async () => {
    project([seam()]);
    let contested = false;
    const runner = new RepairRunner((stage) => {
      if (stage === "smoke-repair" && !contested) {
        contested = true;
        fs.writeFileSync(
          path.join(dir, ".sfo", "CONTEST.json"),
          JSON.stringify({
            sliceId: "SMOKE",
            criterionId: "AC-001",
            testFile: "smoke/test_smoke_anthropic_batch.py",
            testName: "test_it",
            claim: "unsatisfiable",
            why: "the fixture is empty",
            proposedFix: "render a real PNG",
          }),
        );
      }
      if (stage.startsWith("adjudicate-")) {
        fs.writeFileSync(
          path.join(dir, ".sfo", "RULING.json"),
          JSON.stringify({ ruling: "uphold", why: "the test is fine", changedFiles: [], question: null }),
        );
      }
    });
    await runSmoke(context(runner, seams({ "anthropic-batch": () => ({ lines: [], exit: 1 }) })));

    const stages = runner.calls.map((c) => path.basename(c.logPath, ".log"));
    expect(stages).toEqual(["smoke-repair", "adjudicate-SMOKE", "smoke-repair", "smoke-repair"]);
    expect(runner.calls[2].prompt).toContain("Your contest was ruled against");
  });
});

describe("a repair that contests every time", () => {
  it("is heard once, then graded, so the loop still ends", async () => {
    project([seam()]);
    const runner = new RepairRunner((stage) => {
      if (stage === "smoke-repair") {
        fs.writeFileSync(
          path.join(dir, ".sfo", "CONTEST.json"),
          JSON.stringify({
            sliceId: "SMOKE",
            criterionId: "AC-001",
            testFile: "smoke/test_smoke_anthropic_batch.py",
            testName: "test_it",
            claim: "unsatisfiable",
            why: "again",
            proposedFix: "none",
          }),
        );
      }
      if (stage.startsWith("adjudicate-")) {
        fs.writeFileSync(
          path.join(dir, ".sfo", "RULING.json"),
          JSON.stringify({ ruling: "uphold", why: "no", changedFiles: [], question: null }),
        );
      }
    });
    await runSmoke(context(runner, seams({ "anthropic-batch": () => ({ lines: [], exit: 1 }) })));

    const stages = runner.calls.map((c) => path.basename(c.logPath, ".log"));
    expect(stages).toEqual(["smoke-repair", "adjudicate-SMOKE", "smoke-repair", "smoke-repair"]);
  }, 10_000);
});

describe("a smoke test that is itself wrong", () => {
  it("goes to the adjudicator after the repairs, and the seam is checked again when amended", async () => {
    project([seam()]);
    let amended = false;
    const runner = new RepairRunner((stage) => {
      if (stage.startsWith("adjudicate-SMOKE")) {
        amended = true;
        fs.writeFileSync(path.join(dir, "smoke/test_smoke_anthropic_batch.py"), "def test_it(): assert 1\n");
        fs.writeFileSync(
          path.join(dir, ".sfo", "RULING.json"),
          JSON.stringify({ ruling: "amend_test", why: "it read the pty after closing it", changedFiles: [], question: null }),
        );
      }
    });
    const spawn = seams({ "anthropic-batch": () => (amended ? ok()() : { lines: [], exit: 1 }) });
    await runSmoke(context(runner, spawn));

    const { readContests } = await import("../../src/core/contest.js");
    expect(readContests("p", env)[0]).toMatchObject({ sliceId: "SMOKE-anthropic-batch", ruling: "amend_test" });
    const records = readSmokeRecords("p", env);
    expect(Math.max(...records.map((r) => r.attempt))).toBe(4);
    expect(latestSmoke(records).every((r) => r.level === "completed")).toBe(true);
  });
});

describe("more than one seam still failing", () => {
  it("sends each seam's own test to the adjudicator, not just the first", async () => {
    project([seam(), OCR]);
    const runner = new RepairRunner();
    await runSmoke(context(runner, seams({ "anthropic-batch": () => ({ lines: [], exit: 1 }), "vision-ocr": () => ({ lines: [], exit: 1 }) })));
    const stages = runner.calls.map((c) => path.basename(c.logPath, ".log"));
    expect(stages.filter((s) => s.startsWith("adjudicate-"))).toEqual(["adjudicate-SMOKE-anthropic-batch", "adjudicate-SMOKE-vision-ocr"]);
  });
});

describe("latestSmoke", () => {
  const r = (seam: string, check: string, attempt: number, level: "failed" | "completed", at: string) => ({ seam, check, level, detail: "", attempt, at });

  it("keeps each seam's most recent result, even when the check names differ", () => {
    const crashed = r("s", "(smoke test)", 1, "failed", "2026-09-30T10:00:00Z");
    const fixed = r("s", "submit", 2, "completed", "2026-09-30T10:05:00Z");
    const other = r("t", "read", 1, "completed", "2026-09-30T10:00:00Z");
    expect(latestSmoke([crashed, other, fixed])).toEqual([other, fixed]);
  });

  it("goes by time, since attempt numbers restart with every smoke run", () => {
    // ut-tower: the last run's attempt 4 failed; this run passed at attempt 4, then re-checked at 1.
    const oldRun = r("colour", "c", 4, "failed", "2026-09-29T17:00:00Z");
    const thisRun = r("colour", "c", 4, "completed", "2026-09-30T16:07:00Z");
    const recheck = r("colour", "c", 1, "completed", "2026-09-30T16:31:00Z");
    expect(latestSmoke([oldRun, thisRun, recheck])).toEqual([recheck]);
  });
});

describe("credentials for uncovered seams", () => {
  it("skips the seam, and says so, when the reference resolves to nothing", async () => {
    const gh = seam({ id: "github", credential: { name: "GITHUB_TOKEN", covers: null } });
    project([gh]);
    writeCredentials("p", { GITHUB_TOKEN: { source: "env", var: "SFO_TEST_NO_GH" } }, env);
    await runSmoke(context(new RepairRunner(), seams({ github: ok() }), { deps: { spawnSeam: seams({ github: ok() }) } }));
    expect(readSmokeRecords("p", env)[0]).toMatchObject({ level: "skipped", detail: "GITHUB_TOKEN not found at env:SFO_TEST_NO_GH" });
  });
});

describe("a smoke check that needs hardware", () => {
  it("is deferred in an unattended run, and planned when the person says it is there", () => {
    fs.mkdirSync(path.join(dir, "smoke"), { recursive: true });
    const magtag = seam({ id: "magtag", kind: "platform", credential: null });
    const declared = new Map([["magtag", { run: ["pio", "test"], needs: ["hardware: MagTag on USB"] }]]);
    const unattended = planSmoke([magtag], "firmware", dir, 2, () => ({ ok: true, env: {} }), declared);
    expect(unattended.run).toEqual([]);
    expect(unattended.skipped[0]).toMatchObject({ level: "deferred", detail: "waiting for: hardware: MagTag on USB" });

    const withBoard = planSmoke([magtag], "firmware", dir, 2, () => ({ ok: true, env: {} }), declared, true);
    expect(withBoard.run[0]).toMatchObject({ command: ["pio", "test"] });
  });
});
