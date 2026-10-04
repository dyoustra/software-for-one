import fs from "node:fs";
import readline from "node:readline/promises";
import { readState, writeState, isStale } from "../core/state.js";
import { deferredWork, hasDeferred } from "../core/deferred.js";
import { runSmoke, readSmokeRecords, latestSmoke } from "../core/smoke.js";
import { installTool } from "../core/install.js";
import { captureRenders } from "../core/presentation.js";
import { startHeartbeat, HEARTBEAT_INTERVAL_MS } from "../core/orchestrator.js";
import { detectArchetype, runVerify, checkSuiteBeforeLock, runPassedGate } from "../core/verify.js";
import { budgetState } from "../core/budget.js";
import { resolveProjectAccess } from "../core/access.js";
import { artifactPath, type Env } from "../core/paths.js";
import { desktopNotifier, type Notifier } from "../core/notify.js";
import { runnerFor } from "./run.js";
import type { Runner } from "../runner/types.js";

export type Ask = (question: string) => Promise<string>;

/**
 * Runs what an unattended run had to leave: checks that need hardware, a
 * device, or a person. In the foreground, because the person is the one who
 * knows whether the board is plugged in — sfo asks rather than guessing.
 */
export async function runChecks(
  id: string,
  env?: Env,
  deps: {
    ask?: Ask;
    runner?: Runner;
    notify?: Notifier;
    log?: (m: string) => void;
    /** The person already said everything listed is here (`--ready`): ask nothing. */
    ready?: boolean;
    /**
     * Run only the declared checks: no repair agent, and no gate, if one
     * fails. For a project built elsewhere, whose commands the person approved
     * one by one, nothing else may run.
     */
    noRepair?: boolean;
  } = {},
): Promise<string> {
  const log = deps.log ?? console.log;
  const state = readState(id, env);
  if (state.status === "running" && !isStale(state)) throw new Error(`${id} is running — check it once it has finished`);
  const work = deferredWork(id, env);
  if (!hasDeferred(work)) return `${id} has nothing waiting for you`;

  if (deps.ready) {
    for (const need of work.needs) log(`ready (--ready): ${need}`);
  }
  const rl = deps.ask || deps.ready ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask: Ask = deps.ask ?? ((q) => (rl as readline.Interface).question(q));
  try {
    for (const need of deps.ready ? [] : work.needs) {
      const answer = (await ask(`Ready: ${need}? [y/N] `)).trim().toLowerCase();
      if (answer !== "y" && answer !== "yes") return `not run — \`sfo check ${id}\` again when you have: ${need}`;
    }
  } finally {
    rl?.close();
  }

  writeState({ ...state, status: "running", pid: process.pid, heartbeatAt: new Date().toISOString() }, env);
  const archetype = detectArchetype(id, env);
  const lines: string[] = [];
  try {
    if (work.install) {
      const record = installTool(id, archetype, env ?? process.env, undefined, true);
      lines.push(...record.commands.map((c) => `install — ${c.name}: ${c.installed ? "ok" : c.detail}`));
    }
    if (work.renders > 0) {
      const renders = captureRenders(id, archetype, env ?? process.env, undefined, true);
      lines.push(`renders — ${renders.filter((r) => !r.error && !r.deferred).length} of ${renders.length} captured`);
    }
    if (work.seams.length > 0) {
      await runSmoke({
        id,
        env,
        runner: deps.runner ?? runnerFor(id, resolveProjectAccess(id, { env }), env),
        archetype,
        verify: runVerify,
        suiteCheck: checkSuiteBeforeLock,
        passedGate: runPassedGate,
        budgetExceeded: () => budgetState(id, env)?.exceeded ?? false,
        withHeartbeat: async (fn) => {
          const stop = startHeartbeat(id, env, HEARTBEAT_INTERVAL_MS);
          try {
            return await fn();
          } finally {
            stop();
          }
        },
        onlySeams: work.seams,
        needsMet: true,
        noRepair: deps.noRepair,
      });
      const latest = latestSmoke(readSmokeRecords(id, env)).filter((r) => work.seams.includes(r.seam));
      lines.push(...latest.map((r) => `${r.seam} — ${r.check}: ${r.level}${r.level === "completed" ? "" : ` (${r.detail.split("\n")[0]})`}`));
    }
  } finally {
    writeState({ ...readState(id, env), status: state.status, pid: null, updatedAt: new Date().toISOString() }, env);
  }

  const summary = artifactPath(id, "SUMMARY.md", env);
  if (fs.existsSync(summary)) {
    const body = fs.readFileSync(summary, "utf8").trimEnd();
    fs.writeFileSync(
      summary,
      `${body}\n\n## Checked with ${work.needs.join("; ")} — ${new Date().toISOString().slice(0, 10)}\n\n${lines.map((l) => `- ${l}`).join("\n")}\n`,
    );
  }
  for (const l of lines) log(l);
  const message = lines.length > 0 ? lines.join("; ") : "nothing ran";
  (deps.notify ?? desktopNotifier)(`sfo: ${state.title}`, `checked with hardware — ${message}`);
  return message;
}
