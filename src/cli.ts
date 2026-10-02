#!/usr/bin/env node
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { randomBytes } from "node:crypto";
import { createProject, warnSlowTriagePath } from "./commands/new.js";
import { triage, triagePathFor } from "./stages/triage.js";

/**
 * Commander does not catch throws from async actions, so without this every
 * error reaches the user as a raw Node stack trace — `sfo run nope` printed an
 * ENOENT from readFileSync rather than "no such project".
 */
function guarded<A extends unknown[]>(fn: (...args: A) => Promise<void> | void) {
  return async (...args: A): Promise<void> => {
    try {
      await fn(...args);
    } catch (error) {
      console.error(`sfo: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  };
}

export function buildProgram(): Command {
  const program = new Command();
  program.name("sfo").description("Software For One").version("0.1.0");

  program
    .command("new")
    .description("Capture an idea and start a run")
    .argument("[idea]", "the idea, in your own words; omit to pipe it in or write it in $EDITOR")
    .option("--budget <usd>", "park the project when spend reaches this many dollars")
    .option("--access <methods>", "how this project may pay for model calls, overriding your profile")
    .option("--no-run", "capture and triage only; start later with `sfo run`")
    .action(guarded(async (arg: string | undefined, opts: { budget?: string; access?: string; run: boolean }) => {
      const { readIdea, editInEditor, readAllStdin } = await import("./commands/new.js");
      const idea = await readIdea(arg, {
        isTTY: Boolean(process.stdin.isTTY),
        readStdin: readAllStdin,
        edit: (template) => editInEditor(template),
      });

      // Parsed before triage, so a malformed ceiling costs nothing.
      const { parseBudget } = await import("./commands/budget.js");
      const ceiling = opts.budget === undefined ? null : parseBudget(opts.budget);

      const { ensureProfile } = await import("./commands/profile.js");
      const { accessFromProfile, parseAccessFlag, resolveAccess } = await import("./core/access.js");
      const profile = await ensureProfile();
      const access = opts.access ? parseAccessFlag(opts.access) : accessFromProfile(profile);
      const resolved = resolveAccess(access, profile);

      // Selected here, and warned about here, so the message lands before the
      // call rather than after ten seconds of unexplained silence. A chosen
      // subscription is not a degradation, so only a guessed route warns.
      const path = triagePathFor(resolved);
      if (resolved.method === "inherit") warnSlowTriagePath(path);

      let verdict = "ready";
      let counterOffer: string | null = null;
      const id = await createProject(
        idea,
        async (i) => {
          const outcome = await triage(i, { path, access: resolved });
          verdict = outcome.result.verdict;
          counterOffer = outcome.result.counterOffer;
          return outcome;
        },
        randomBytes(3).toString("hex"),
        undefined,
        access,
      );
      console.log(`captured: ${id}`);
      const { snapshotPreferences } = await import("./core/preferences.js");
      snapshotPreferences(id);

      if (ceiling !== null) {
        const { writeBudget } = await import("./core/budget.js");
        writeBudget(id, ceiling);
        console.log(`budget ceiling: $${ceiling.toFixed(2)}`);
      }

      // Printed before anything is spent: the front half runs on `sfo run`,
      // and this is the last cheap moment to walk away.
      const { readEstimate, formatEstimate } = await import("./core/estimate.js");
      const front = readEstimate(id).find((e) => e.phase === "front");
      if (front) console.log(formatEstimate(front));

      // Starting an idea triage called out of scope spends money on something
      // it just said this cannot build; the counter-offer is the useful part.
      if (verdict === "out_of_scope") {
        console.log(`triage: out of scope${counterOffer ? ` — it could build this instead: ${counterOffer}` : ""}`);
        console.log(`not started — \`sfo run ${id}\` to build it anyway`);
        return;
      }
      if (!opts.run) {
        console.log(`not started — \`sfo run ${id}\` when you are ready`);
        return;
      }
      const { guardRunnable, runDetached } = await import("./commands/run.js");
      guardRunnable(id);
      console.log(`started (pid ${runDetached(id)}) — you'll get a notification when it needs you or is done`);
    }));

  program
    .command("run")
    .description("Advance a project until done or blocked")
    .argument("<id>", "project id")
    .option("--attach", "run in this process and stream progress")
    .option("--anyway", "build it even though research found prior art")
    .option("--use-api-key", "run on your API key this time, whatever your profile prefers")
    .action(guarded(async (id: string, opts: { attach?: boolean; anyway?: boolean; useApiKey?: boolean }) => {
      const { runAttached, runDetached, guardRunnable } = await import("./commands/run.js");
      guardRunnable(id, undefined, opts);
      if (opts.attach) {
        await runAttached(id, opts);

        // Reported here rather than left for the human to find on their next
        // `sfo status`: a follow-up asked while they are still at the keyboard
        // costs seconds, and hours once they have walked away. The orchestrator
        // returns state; the command layer decides what to say about it.
        const { openQuestions } = await import("./core/openQuestions.js");
        const open = openQuestions(id);
        if (open.length > 0) {
          console.log(`\nsfo: ${open.length} question(s) still open — run \`sfo answer ${id}\``);
        }
      } else {
        console.log(`started (pid ${runDetached(id, opts)})`);
      }
    }));

  program
    .command("feedback")
    .description("Ask for a change to a finished project, in your own words")
    .argument("<id>", "project id")
    .argument("[text]", "the feedback; omit to write it in $EDITOR or pipe it in")
    .option("--attach", "apply it in this terminal instead of in the background")
    .option("--entry <n>", "apply an already-recorded entry (used by the background run)")
    .action(guarded(async (id: string, text: string | undefined, opts: { attach?: boolean; entry?: string }) => {
      const { recordFeedback, runFeedbackAttached, startFeedbackDetached } = await import("./commands/feedback.js");
      let n: number;
      if (opts.entry) {
        n = Number(opts.entry);
      } else {
        const { readIdea, editInEditor, readAllStdin } = await import("./commands/new.js");
        const words = await readIdea(text, {
          isTTY: Boolean(process.stdin.isTTY),
          readStdin: readAllStdin,
          edit: () => editInEditor("\n# What should change? Lines starting with # are ignored.\n"),
        });
        n = recordFeedback(id, words);
      }
      if (opts.attach) {
        const outcome = await runFeedbackAttached(id, n);
        console.log(outcome.outcome === "done" ? `applied: ${outcome.summary}` : JSON.stringify(outcome));
      } else {
        console.log(`feedback ${n} recorded; applying it (pid ${startFeedbackDetached(id, n)}) — you'll get a notification`);
      }
    }));

  program
    .command("preferences")
    .description("Edit your standing preferences: stacks, storage, delivery — guidance every new project reads")
    .option("--show", "print them instead of opening the editor")
    .action(guarded(async (opts: { show?: boolean }) => {
      const fs = await import("node:fs");
      const { preferencesPath, readPreferences, PREFERENCES_TEMPLATE } = await import("./core/preferences.js");
      const file = preferencesPath();
      if (opts.show) {
        console.log(readPreferences() ?? "no preferences yet — `sfo preferences` to write some");
        return;
      }
      if (!fs.existsSync(file)) fs.writeFileSync(file, PREFERENCES_TEMPLATE);
      const { spawnSync } = await import("node:child_process");
      const editor = process.env.VISUAL || process.env.EDITOR || "vi";
      spawnSync(`${editor} "$SFO_PREFS"`, { shell: true, stdio: "inherit", env: { ...process.env, SFO_PREFS: file } });
      console.log(`saved ${file}`);
    }));

  program
    .command("check")
    .description("Run the checks that were waiting for hardware, a device, or you")
    .argument("<id>", "project id")
    .action(guarded(async (id: string) => {
      const { runChecks } = await import("./commands/check.js");
      console.log(await runChecks(id));
    }));

  program
    .command("stop")
    .description("Stop a running project, leaving everything it made in place")
    .argument("<id>", "project id")
    .action(guarded(async (id: string) => {
      const { stopRun } = await import("./commands/stop.js");
      console.log(stopRun(id));
    }));

  program
    .command("budget")
    .description("Show or set a project's spending ceiling")
    .argument("<id>", "project id")
    .argument("[usd]", "new ceiling in dollars, or `none` to remove it; omit to show the current one")
    .option("--billed-only", "count only billed spend, not usage drawn from a Claude subscription")
    .option("--smoke <usd>", "what one smoke run may spend on real calls (default $2)")
    .action(guarded(async (id: string, usd: string | undefined, opts: { billedOnly?: boolean; smoke?: string }) => {
      const { showBudget, setBudget, setSmokeCap } = await import("./commands/budget.js");
      if (opts.smoke !== undefined) setSmokeCap(id, opts.smoke);
      if (usd !== undefined) setBudget(id, usd, undefined, opts.billedOnly ?? false);
      if (usd === undefined && opts.smoke === undefined) showBudget(id);
    }));

  program
    .command("profile")
    .description("Show or change how you pay for model calls")
    .argument("[action]", "`setup` to answer the first-run questions again, or `set`")
    .argument("[setting]", "access, key, prefers or fallback")
    .argument("[value]", "the new value")
    .action(guarded(async (action?: string, setting?: string, value?: string) => {
      const { formatProfile, setupProfileInteractively, setProfile } = await import("./commands/profile.js");
      const { readProfile } = await import("./core/access.js");
      if (action === undefined) {
        console.log(formatProfile(readProfile()));
      } else if (action === "setup") {
        await setupProfileInteractively();
      } else if (action === "set" && setting !== undefined && value !== undefined) {
        console.log(formatProfile(setProfile(setting, value)));
      } else {
        throw new Error("usage: sfo profile [setup | set <access|key|prefers|fallback> <value>]");
      }
    }));

  program
    .command("status")
    .description("Show all projects")
    .action(guarded(async () => {
      const { listProjects, formatStatus } = await import("./commands/status.js");
      console.log(formatStatus(listProjects()));
    }));

  program
    .command("logs")
    .description("Show the current stage's log")
    .argument("<id>", "project id")
    .option("-f, --follow", "keep following, switching to each new stage or slice as it starts")
    .option("--raw", "the stream-json log as written, not rendered")
    .action(guarded(async (id: string, opts: { follow?: boolean; raw?: boolean }) => {
      const { showLogs } = await import("./commands/logs.js");
      showLogs(id, opts.follow ?? false, undefined, { raw: opts.raw });
    }));

  program
    .command("answer")
    .description("Answer a project's open questions")
    .argument("<id>", "project id")
    .action(guarded(async (id: string) => {
      const { promptForAnswers } = await import("./commands/answer.js");
      await promptForAnswers(id);
    }));

  program
    .command("stage")
    .description("Re-run a single stage in isolation")
    .argument("<id>", "project id")
    .argument("<stage>", "stage name")
    .action(guarded(async (id: string, stage: string) => {
      const { runSingleStage } = await import("./commands/stage.js");
      await runSingleStage(id, stage);
    }));

  program
    .command("cost")
    .description("Show what has been spent")
    .argument("[id]", "project id; omit for every project")
    .action(guarded(async (id?: string) => {
      const { showCost } = await import("./commands/cost.js");
      showCost(id);
    }));

  program
    .command("retry")
    .description("Retry what failed — slices, seams and unrepaired findings — or one named slice")
    .argument("<id>", "project id")
    .argument("[slice]", "slice id; omit to retry every failed slice")
    .action(guarded(async (id: string, slice?: string) => {
      const { retrySlices, retryFailed } = await import("./commands/retry.js");
      console.log(slice ? retrySlices(id, slice) : retryFailed(id));
    }));

  program
    .command("criteria")
    .description("Show a project's acceptance criteria")
    .argument("<id>", "project id")
    .action(guarded(async (id: string) => {
      const { showCriteria } = await import("./commands/criteria.js");
      showCriteria(id);
    }));

  program
    .command("why")
    .description("Show the prior-art verdict — what already exists, and whether it stopped the run")
    .argument("<id>", "project id")
    .action(guarded(async (id: string) => {
      const { showWhy } = await import("./commands/why.js");
      showWhy(id);
    }));

  program
    .command("decisions")
    .description("Show the calls the pipeline made, highest blast radius first")
    .argument("<id>", "project id")
    .action(guarded(async (id: string) => {
      const { showDecisions } = await import("./commands/decisions.js");
      showDecisions(id);
    }));

  program
    .command("slices")
    .description("Show the build slices, in the order they will be built")
    .argument("<id>", "project id")
    .action(guarded(async (id: string) => {
      const { showSlices } = await import("./commands/slices.js");
      showSlices(id);
    }));

  return program;
}

/**
 * Whether this module is the program being run, not one being imported. By
 * resolved path: the installed `sfo` is a symlink, so `argv[1]` names the
 * link, and a check on its name ran nothing and exited 0.
 */
export function isEntryPoint(argv1: string | undefined, moduleUrl: string): boolean {
  if (!argv1) return false;
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isEntryPoint(process.argv[1], import.meta.url)) buildProgram().parse();
