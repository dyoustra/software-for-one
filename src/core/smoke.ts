import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import { artifactPath, projectDir, logPath, type Env } from "./paths.js";
import { readRecords, appendRecord } from "./jsonl.js";
import { readServices, readCredentials, smokeTestFile, type Service, type Credentials } from "./services.js";
import { readProfile, readKey, describeKeyRef, DEFAULT_KEY_REF, type KeyReader, type Profile } from "./access.js";
import { smokeRunnerFor, verifyRecipeFor } from "./archetype.js";
import { readSmokeCap } from "./budget.js";
import { recordCost } from "./cost.js";
import { readState } from "./state.js";
import { readSlices, type Slice } from "./slices.js";
import { commitStage, changedPaths, discardPaths } from "./repo.js";
import { verifyTestLock } from "./testlock.js";
import { TEST_DIR, agentToolsForStage, type VerifyResult } from "./verify.js";
import { takeContest, contestFor, contestInstructions } from "./contest.js";
import { adjudicate, type AdjudicationContext } from "./adjudicate.js";
import { loadPrompt } from "../stages/prompts.js";
import type { Runner, UsageLimit } from "../runner/types.js";

export const SMOKE_FILE = "SMOKE.jsonl";

/** How long an async seam gets to finish before it is recorded as accepted only. */
export const SMOKE_ASYNC_WAIT_SECONDS = 300;

/** A synchronous seam that takes longer than this is hung, not slow. */
const SYNC_TIMEOUT_MS = 120_000;

export const MAX_SMOKE_REPAIRS = 2;

/** The contest id for the smoke suite, which belongs to no slice. */
export const SMOKE_CONTEST_ID = "SMOKE";

export const SMOKE_LEVELS = ["completed", "accepted", "failed", "skipped"] as const;
export type SmokeLevel = (typeof SMOKE_LEVELS)[number];

/** What a smoke test writes: one line per check to `$SFO_SMOKE_RESULTS`. */
export const SmokeLineSchema = z.object({
  seam: z.string().min(1),
  check: z.string().min(1),
  level: z.enum(SMOKE_LEVELS),
  detail: z.string(),
  costUsd: z.number().nonnegative().optional(),
});
export type SmokeLine = z.infer<typeof SmokeLineSchema>;

export const SmokeRecordSchema = SmokeLineSchema.extend({
  /** 1 for the first smoke run; each repair's re-run adds one. */
  attempt: z.number().int().positive(),
  at: z.string(),
});
export type SmokeRecord = z.infer<typeof SmokeRecordSchema>;

export function readSmokeRecords(id: string, env?: Env): SmokeRecord[] {
  return readRecords(artifactPath(id, SMOKE_FILE, env), SmokeRecordSchema);
}

/**
 * Each seam's most recent attempt: what the project delivered with. By seam
 * rather than by check, because a test that crashed reports under a placeholder
 * check, and keying by check would let that failure outlive the fix.
 */
export function latestSmoke(records: SmokeRecord[]): SmokeRecord[] {
  const lastAttempt = new Map<string, number>();
  for (const r of records) lastAttempt.set(r.seam, Math.max(lastAttempt.get(r.seam) ?? 0, r.attempt));
  return records.filter((r) => r.attempt === lastAttempt.get(r.seam));
}

/** Spawns one smoke file. Injectable so tests never make a real call. */
export type SeamProcess = (opts: {
  cwd: string;
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
  timeoutMs: number;
}) => Promise<{ exitCode: number | null; output: string; timedOut: boolean }>;

const OUTPUT_TAIL = 64 * 1024;

/**
 * Async, unlike the gate's `spawnSync`: an async seam waits minutes on its
 * service, and a blocked event loop stops the heartbeat, so the project would
 * read as dead while it waited.
 */
export const spawnSeam: SeamProcess = ({ cwd, command, args, env, timeoutMs }) =>
  new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const keep = (chunk: Buffer): void => {
      output = (output + chunk.toString("utf8")).slice(-OUTPUT_TAIL);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: null, output: `could not run ${command}: ${err.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, output, timedOut });
    });
  });

export interface SmokeDeps {
  spawnSeam?: SeamProcess;
  readKeyWith?: KeyReader;
}

type Resolved = { ok: true; env: Record<string, string> } | { ok: false; why: string };

/**
 * The one credential a seam reads, resolved for its process alone. A covered
 * credential comes through the profile, as sfo's own runs' does; any other
 * from the project's references.
 */
export function resolveSeamCredential(
  service: Service,
  profile: Profile | null,
  credentials: Credentials,
  env: Env,
  reader: KeyReader = readKey,
): Resolved {
  const credential = service.credential;
  if (!credential) return { ok: true, env: {} };

  if (credential.covers === "claude_subscription") {
    return profile?.modelAccess.includes("claude_subscription")
      ? { ok: true, env: {} }
      : { ok: false, why: "needs a Claude subscription, which your profile does not list" };
  }
  const ref =
    credential.covers === "anthropic_api_key"
      ? (profile?.apiKey ?? DEFAULT_KEY_REF)
      : credentials[credential.name];
  if (!ref) {
    return { ok: false, why: `no reference to ${credential.name} was recorded — answer its question at clarify` };
  }
  const value = reader(ref, env);
  return value
    ? { ok: true, env: { [credential.name]: value } }
    : { ok: false, why: `${credential.name} not found at ${describeKeyRef(ref)}` };
}

interface Planned {
  run: { service: Service; file: string; credential: Record<string, string> }[];
  skipped: SmokeLine[];
}

/** Which seams run, in list order, and why each of the rest does not. */
export function planSmoke(
  services: Service[],
  archetype: string,
  dir: string,
  capUsd: number,
  resolve: (service: Service) => Resolved,
): Planned {
  const planned: Planned = { run: [], skipped: [] };
  let committed = 0;
  const skip = (service: Service, detail: string): void => {
    for (const check of service.smoke.checks.length > 0 ? service.smoke.checks : ["(any)"]) {
      planned.skipped.push({ seam: service.id, check, level: "skipped", detail });
    }
  };

  for (const service of services) {
    if (service.effect === "irreversible" && !service.testMode) {
      skip(service, "irreversible, and the service has no test mode — not run unattended");
      continue;
    }
    const file = smokeTestFile(service, archetype);
    if (!fs.existsSync(path.join(dir, file))) {
      skip(service, `no smoke test was written for this seam (${file})`);
      continue;
    }
    const credential = resolve(service);
    if (!credential.ok) {
      skip(service, credential.why);
      continue;
    }
    if (committed + service.smoke.maxCostUsd > capUsd) {
      skip(service, `over the $${capUsd.toFixed(2)} smoke cap ($${service.smoke.maxCostUsd.toFixed(2)} declared)`);
      continue;
    }
    committed += service.smoke.maxCostUsd;
    planned.run.push({ service, file, credential: credential.env });
  }
  return planned;
}

function tail(text: string, lines = 30): string {
  return text.trim().split("\n").slice(-lines).join("\n");
}

/**
 * Runs one seam's file and reads what it reported. A process that exited
 * non-zero failed whatever it wrote: a test that recorded `accepted` and then
 * raised did not get as far as it said.
 */
async function runSeam(
  id: string,
  archetype: string,
  planned: Planned["run"][number],
  base: NodeJS.ProcessEnv,
  spawnWith: SeamProcess,
  env: Env | undefined,
): Promise<{ lines: SmokeLine[]; output: string }> {
  const { service, file, credential } = planned;
  const runner = smokeRunnerFor(archetype, file);
  if (!runner) {
    return { lines: [{ seam: service.id, check: "(any)", level: "skipped", detail: `no smoke runner for "${archetype}"` }], output: "" };
  }

  const results = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sfo-smoke-")), "results.jsonl");
  // Nothing from sfo's own credentials: only the one this seam reads.
  const { ANTHROPIC_API_KEY: _k, ANTHROPIC_AUTH_TOKEN: _t, ...rest } = base;
  const run = await spawnWith({
    cwd: projectDir(id, env),
    command: runner.command,
    args: runner.args,
    env: {
      ...rest,
      ...credential,
      SFO_SMOKE_RESULTS: results,
      SFO_SMOKE_ASYNC_WAIT_SECONDS: String(SMOKE_ASYNC_WAIT_SECONDS),
    },
    timeoutMs: service.smoke.async ? (SMOKE_ASYNC_WAIT_SECONDS + 120) * 1000 : SYNC_TIMEOUT_MS,
  });

  const reported: SmokeLine[] = [];
  let malformed = 0;
  if (fs.existsSync(results)) {
    for (const raw of fs.readFileSync(results, "utf8").split("\n")) {
      if (raw.trim() === "") continue;
      try {
        const parsed = SmokeLineSchema.safeParse(JSON.parse(raw));
        if (parsed.success) reported.push({ ...parsed.data, seam: service.id });
        else malformed++;
      } catch {
        malformed++;
      }
    }
  }
  const note = malformed > 0 ? ` (${malformed} unreadable result line${malformed === 1 ? "" : "s"})` : "";

  if (run.exitCode !== 0) {
    const why = run.timedOut ? "timed out" : run.exitCode === null ? "could not run" : `exited ${run.exitCode}`;
    const detail = `${why}${note}:\n${tail(run.output)}`;
    const lines =
      reported.length > 0
        ? reported.map((r) => (r.level === "skipped" ? r : { ...r, level: "failed" as const, detail: `${r.detail} — then ${detail}` }))
        : [{ seam: service.id, check: "(smoke test)", level: "failed" as const, detail }];
    return { lines, output: run.output };
  }
  if (reported.length === 0) {
    return {
      lines: [{ seam: service.id, check: "(smoke test)", level: "completed", detail: `passed, but reported no result${note}` }],
      output: run.output,
    };
  }
  return { lines: reported, output: run.output };
}

export type SmokeOutcome =
  | { outcome: "complete" }
  | { outcome: "failed"; reason: string }
  | { outcome: "limit"; stage: string; limit: UsageLimit }
  | { outcome: "budget"; stage: string };

export interface SmokeContext {
  id: string;
  env: Env | undefined;
  runner: Runner;
  archetype: string;
  verify: AdjudicationContext["verify"];
  suiteCheck: AdjudicationContext["suiteCheck"];
  /** The gate for a repair: every passed slice's tests at once. */
  passedGate: (id: string, archetype: string, passed: Slice[], env?: Env, extraTests?: string[]) => VerifyResult;
  /** Run the seams and record them, but attempt no repair: the re-check after review repairs. */
  noRepair?: boolean;
  budgetExceeded: () => boolean;
  withHeartbeat: <T>(fn: () => Promise<T>) => Promise<T>;
  deps?: SmokeDeps;
}

function record(id: string, lines: SmokeLine[], attempt: number, env: Env | undefined): void {
  const at = new Date().toISOString();
  for (const line of lines) appendRecord(artifactPath(id, SMOKE_FILE, env), SmokeRecordSchema, { ...line, attempt, at });
}

function repairPrompt(failures: SmokeLine[], outputs: Map<string, string>, gate: string[], previous: string | null, contest: ReturnType<typeof contestFor>): string {
  return [
    loadPrompt("smoke"),
    "",
    "## What failed",
    "",
    ...failures.flatMap((f) => [
      `### ${f.seam}: ${f.check}`,
      "",
      "```",
      f.detail,
      "```",
      "",
      ...(outputs.get(f.seam) ? ["Test output (tail):", "", "```", tail(outputs.get(f.seam) ?? "", 60), "```", ""] : []),
    ]),
    "## The gate",
    "",
    "Your change is kept only if every one of these exits 0, in this order:",
    "",
    ...gate.map((c) => `    ${c}`),
    "",
    ...contestInstructions(SMOKE_CONTEST_ID, contest),
    ...(previous
      ? ["", "## Your previous repair failed the gate and was discarded", "", "```", previous, "```"]
      : []),
  ].join("\n");
}

/**
 * Exercises every real seam once, then repairs what failed. Mechanical except
 * for the repair: nothing here asks a model whether a seam works.
 */
export async function runSmoke(ctx: SmokeContext): Promise<SmokeOutcome> {
  const { id, env, archetype } = ctx;
  const dir = projectDir(id, env);
  const spawnWith = ctx.deps?.spawnSeam ?? spawnSeam;
  const reader = ctx.deps?.readKeyWith ?? readKey;

  let services: Service[];
  let credentials: Credentials;
  try {
    services = readServices(id, env);
    credentials = readCredentials(id, env);
  } catch (err) {
    return { outcome: "failed", reason: `${err instanceof Error ? err.message : String(err)} — re-run \`sfo stage ${id} spec\`` };
  }
  // A project from before seams were listed has nothing to exercise.
  if (services.length === 0) return { outcome: "complete" };

  // The smoke suite is graded like every other test: if it changed after the
  // lock, a build agent shaped it, and its verdicts mean nothing.
  const drift = verifyTestLock(id, TEST_DIR, env);
  if (drift.length > 0) {
    return { outcome: "failed", reason: `the test suite changed since it was locked: ${drift.join(", ")}` };
  }

  const profile = readProfile(env);
  const plan = planSmoke(services, archetype, dir, readSmokeCap(id, env), (s) =>
    resolveSeamCredential(s, profile, credentials, process.env, reader),
  );

  const outputs = new Map<string, string>();
  const runSeams = async (which: Planned["run"]): Promise<SmokeLine[]> => {
    const lines: SmokeLine[] = [];
    for (const planned of which) {
      const result = await runSeam(id, archetype, planned, process.env, spawnWith, env);
      outputs.set(planned.service.id, result.output);
      lines.push(...result.lines);
    }
    const spent = lines.reduce((sum, l) => sum + (l.costUsd ?? 0), 0);
    if (spent > 0) {
      recordCost(
        id,
        "smoke",
        true,
        { costUsd: spent, durationMs: 0, numTurns: 0, inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
        env,
        "sdk",
        "api",
      );
    }
    return lines;
  };

  let attempt = 1;
  const first = await ctx.withHeartbeat(() => runSeams(plan.run));
  record(id, [...first, ...plan.skipped], attempt, env);

  let failing = first.filter((l) => l.level === "failed");
  const passed = (): Slice[] => {
    const ids = new Set(readState(id, env).slicesPassed);
    return readSlices(id, env).filter((s) => ids.has(s.id));
  };
  if (failing.length === 0 || passed().length === 0 || ctx.noRepair) return { outcome: "complete" };

  let repairs = 0;
  let previous: string | null = null;
  const smokeSlice: Slice = { id: SMOKE_CONTEST_ID, name: "smoke tests", criterionIds: ["(smoke)"], prerequisites: [] };

  while (failing.length > 0 && repairs < MAX_SMOKE_REPAIRS) {
    if (ctx.budgetExceeded()) return { outcome: "budget", stage: "smoke-repair" };

    const gate = verifyRecipeFor(archetype).map((s) => [s.command, ...s.args].join(" "));
    const result = await ctx.withHeartbeat(() =>
      ctx.runner.runStage({
        workdir: dir,
        prompt: repairPrompt(failing, outputs, gate, previous, contestFor(id, SMOKE_CONTEST_ID, env)),
        logPath: logPath(id, "smoke-repair", env),
        allowedTools: agentToolsForStage(id, "smoke-repair", env),
      }),
    );
    recordCost(id, "smoke-repair", result.ok, result.usage, env, "cli", result.billing);
    if (result.limited) return { outcome: "limit", stage: "smoke-repair", limit: result.limited };

    const taken = takeContest(id, SMOKE_CONTEST_ID, env);
    if (taken.kind === "contest" && !contestFor(id, SMOKE_CONTEST_ID, env)) {
      const slices = readSlices(id, env);
      const adjudicated = await adjudicate(
        { id, env, runner: ctx.runner, archetype, slices, verify: ctx.verify, suiteCheck: ctx.suiteCheck, withHeartbeat: ctx.withHeartbeat },
        smokeSlice,
        taken.contest,
        false,
      );
      if (adjudicated.kind === "limit") return { outcome: "limit", stage: adjudicated.stage, limit: adjudicated.limit };
    } else {
      repairs++;
      const verdict = ctx.passedGate(id, archetype, passed(), env);
      if (!verdict.ok) {
        // Kept only if it keeps every built slice green; otherwise it is gone,
        // and the failure it caused is the next attempt's starting point.
        discardPaths(dir, changedPaths(dir));
        const step = verdict.steps.find((s) => !s.ok);
        previous = [verdict.reason ?? "", step?.output ? tail(step.output, 60) : ""].filter(Boolean).join("\n");
        continue;
      }
      commitStage(id, "smoke-repair", env);
      previous = null;
    }

    const failingSeams = new Set(failing.map((f) => f.seam));
    attempt++;
    const rerun = await ctx.withHeartbeat(() => runSeams(plan.run.filter((p) => failingSeams.has(p.service.id))));
    record(id, rerun, attempt, env);
    failing = rerun.filter((l) => l.level === "failed");
  }
  return { outcome: "complete" };
}
