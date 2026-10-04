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
    .option("--local", "build it on this machine instead of on a Sprite of its own")
    .action(guarded(async (arg: string | undefined, opts: { budget?: string; access?: string; run: boolean; local?: boolean }) => {
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
      // The cloud is the default: a project's own Sprite is the only place its
      // agents, and the code they write, are confined. It never falls back to
      // this machine on its own.
      if (!opts.local) {
        if (opts.access) throw new Error("--access works only with --local for now: a cloud project uses your profile");
        const { newCloudProject } = await import("./core/cloud.js");
        const { spriteCli } = await import("./core/sprite.js");
        await newCloudProject(idea, { budget: opts.budget, run: opts.run }, profile, { cli: spriteCli });
        return;
      }
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
      const { snapshotPreferences, readPreferences } = await import("./core/preferences.js");
      snapshotPreferences(id);
      const prefs = readPreferences();
      const { writeBudget, writeSmokeCap } = await import("./core/budget.js");
      writeSmokeCap(id, prefs.smokeCapUsd);

      // --budget wins; otherwise the person's standing default, if they set one.
      const startingCeiling = ceiling ?? prefs.budgetUsd;
      if (startingCeiling !== null) {
        writeBudget(id, startingCeiling);
        console.log(`budget ceiling: $${startingCeiling.toFixed(2)}`);
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
      const { guardRunnable } = await import("./commands/run.js");
      const { localHost } = await import("./core/host.js");
      guardRunnable(id);
      console.log(`started (${localHost().start(id, { kind: "run" })}) — you'll get a notification when it needs you or is done`);
    }));

  program
    .command("run")
    .description("Advance a project until done or blocked")
    .argument("<id>", "project id")
    .option("--attach", "run in this process and stream progress")
    .option("--anyway", "build it even though research found prior art")
    .option("--use-api-key", "run on your API key this time, whatever your profile prefers")
    .action(guarded(async (id: string, opts: { attach?: boolean; anyway?: boolean; useApiKey?: boolean }) => {
      const { runAttached, guardRunnable } = await import("./commands/run.js");
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
        const { localHost } = await import("./core/host.js");
        console.log(`started (${localHost().start(id, { kind: "run", anyway: opts.anyway, useApiKey: opts.useApiKey })})`);
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
      const { recordFeedback, runFeedbackAttached } = await import("./commands/feedback.js");
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
        const recorded = recordFeedback(id, words);
        if (recorded.queued) {
          console.log(`feedback ${recorded.n} queued — it is applied after the feedback already in progress, and you'll get a notification for each`);
          return;
        }
        n = recorded.n;
      }
      if (opts.attach) {
        for (const outcome of await runFeedbackAttached(id, n)) {
          console.log(outcome.outcome === "done" ? `applied: ${outcome.summary}` : JSON.stringify(outcome));
        }
      } else {
        const { localHost } = await import("./core/host.js");
        console.log(`feedback ${n} recorded; applying it (${localHost().start(id, { kind: "feedback", entry: n })}) — add more with \`sfo feedback ${id}\` and it queues; you'll get a notification for each`);
      }
    }));

  program
    .command("prefs")
    .alias("preferences")
    .description("Your standing preferences: languages by kind, web host and data, default budgets; `edit` opens SFO.md")
    .argument("[setting]", "languages, web-host, web-data, budget, smoke-cap, or edit")
    .argument("[values...]", "the new value; for languages, the kind then a comma-separated ranking")
    .action(guarded(async (setting: string | undefined, values: string[]) => {
      const prefs = await import("./core/preferences.js");
      if (setting === undefined) {
        console.log(prefs.formatPreferences(prefs.readPreferences()));
        console.log(`\nfree text: ${prefs.readSfoMd()?.trim() ? prefs.sfoMdPath() : "none yet — `sfo prefs edit`"}`);
        return;
      }
      if (setting === "edit") {
        const fs = await import("node:fs");
        const file = prefs.sfoMdPath();
        if (prefs.readSfoMd() === null) fs.writeFileSync(file, prefs.SFO_MD_TEMPLATE);
        const { spawnSync } = await import("node:child_process");
        const editor = process.env.VISUAL || process.env.EDITOR || "vi";
        spawnSync(`${editor} "$SFO_PREFS"`, { shell: true, stdio: "inherit", env: { ...process.env, SFO_PREFS: file } });
        console.log(`saved ${file}`);
        return;
      }
      console.log(prefs.formatPreferences(prefs.setPreference(setting, values)));
    }));

  program
    .command("check")
    .description("Run the checks that were waiting for hardware, a device, or you")
    .argument("<id>", "project id")
    .option("--ready", "everything the checks need is here; skip asking")
    .option("--yes", "for a cloud project, run its commands here without showing them first")
    .action(guarded(async (id: string, opts: { ready?: boolean; yes?: boolean }) => {
      const { runChecks } = await import("./commands/check.js");
      const { cloudEntry, pullProject, pushProjectBack } = await import("./core/cloud.js");
      if (!cloudEntry(id)) {
        console.log(await runChecks(id, undefined, { ready: opts.ready }));
        return;
      }
      // The hardware is here, not on the Sprite: check a copy, then send the
      // results back to where the project lives.
      const { spriteCli } = await import("./core/sprite.js");
      console.log(`pulled to ${await pullProject(id, { cli: spriteCli })}`);
      // Written on a Sprite where nothing confined the agents, and about to
      // run here with this person's rights: they see what first.
      const { deferredCommands } = await import("./core/deferred.js");
      const commands = deferredCommands(id);
      if (commands.length > 0 && !opts.yes) {
        console.log(
          `these run on this machine, as you — and an install or test runs the project's own code, written on the Sprite:\n${commands.map((c) => `  ${c}`).join("\n")}`,
        );
        const readline = await import("node:readline/promises");
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await rl.question("run them? [y/N] ");
        rl.close();
        if (!/^y(es)?$/i.test(answer.trim())) {
          console.log("not run");
          return;
        }
      }
      console.log(await runChecks(id, undefined, { ready: opts.ready, noRepair: true }));
      await pushProjectBack(id, { cli: spriteCli });
      console.log("results sent back to the Sprite");
    }));

  program
    .command("login")
    .description("Sign this machine in to the control plane, approving it where you are signed in with Apple")
    .action(guarded(async () => {
      const { login } = await import("./commands/login.js");
      await login();
    }));

  program
    .command("connect")
    .description("Connect an account the control plane uses for you (github)")
    .argument("<service>", "github")
    .action(guarded(async (service: string) => {
      if (service !== "github") throw new Error("only `sfo connect github` exists");
      const { connectGithub } = await import("./commands/login.js");
      await connectGithub();
    }));

  program
    .command("logout")
    .description("Sign this machine out of the control plane and revoke its token")
    .action(guarded(async () => {
      const { logout } = await import("./commands/login.js");
      console.log(await logout());
    }));

  program
    .command("install")
    .description("Put a project where you use it, on this machine (a cloud project is pulled here first)")
    .argument("<id>", "project id")
    .option("--yes", "for a cloud project, run its install here without showing it first")
    .action(guarded(async (id: string, opts: { yes?: boolean }) => {
      const { installTool, declaredInstall } = await import("./core/install.js");
      const { detectArchetype } = await import("./core/verify.js");
      const { cloudEntry, pullProject } = await import("./core/cloud.js");
      if (cloudEntry(id)) {
        const { spriteCli } = await import("./core/sprite.js");
        console.log(`pulled to ${await pullProject(id, { cli: spriteCli })}`);
        // Written on a Sprite, about to run here as the person: shown first,
        // and nothing that cannot be shown.
        const commands = declaredInstall(id);
        if (!commands) throw new Error(`${id} declares no install in CONTRACTS.json, so what installing it would run here cannot be shown — not installing`);
        if (!opts.yes) {
          const { shown } = await import("./core/deferred.js");
          console.log(`these run on this machine, as you — and installing runs the project's own build, written on the Sprite:\n${commands.map((c) => `  ${shown(c)}`).join("\n")}`);
          const readline = await import("node:readline/promises");
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          const answer = await rl.question("run them? [y/N] ");
          rl.close();
          if (!/^y(es)?$/i.test(answer.trim())) {
            console.log("not installed");
            return;
          }
        }
      }
      // Asked for here, by the person at this machine: whatever the install waits for is here.
      const record = installTool(id, detectArchetype(id), process.env, undefined, true);
      for (const c of record.commands) console.log(`${c.installed ? "installed" : "not installed"} — ${c.name}: ${c.detail}`);
      if (record.commands.some((c) => !c.installed)) process.exitCode = 1;
    }));

  program
    .command("pull")
    .description("Copy a cloud project to this machine (its Sprite stays the original)")
    .argument("<id>", "project id")
    .action(guarded(async (id: string) => {
      const { pullProject } = await import("./core/cloud.js");
      const { spriteCli } = await import("./core/sprite.js");
      console.log(`pulled to ${await pullProject(id, { cli: spriteCli })}`);
    }));

  program
    .command("destroy")
    .description("Delete a cloud project's Sprite and everything on it (its GitHub repo stays)")
    .argument("<id>", "project id")
    .option("--yes", "do not ask first")
    .action(guarded(async (id: string, opts: { yes?: boolean }) => {
      const { cloudEntry, destroyCloudProject } = await import("./core/cloud.js");
      const entry = cloudEntry(id);
      if (!entry) throw new Error(`${id} is not a cloud project — only cloud projects can be destroyed`);
      if (!opts.yes) {
        const readline = await import("node:readline/promises");
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await rl.question(
          `Delete Sprite ${entry.sprite} and everything on it${entry.repo ? ` (the repo ${entry.repo} stays)` : " — it has no repo, so this is the only copy"}? [y/N] `,
        );
        rl.close();
        if (!/^y(es)?$/i.test(answer.trim())) {
          console.log("not destroyed");
          return;
        }
      }
      const { spriteCli } = await import("./core/sprite.js");
      await destroyCloudProject(id, { cli: spriteCli });
      console.log(`destroyed ${entry.sprite}`);
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
    .argument("[setting]", "access, key, prefers, fallback, cloud-token or github")
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
        throw new Error("usage: sfo profile [setup | set <access|key|prefers|fallback|cloud-token|github> <value>]");
      }
    }));

  program
    .command("status")
    .description("Show all projects")
    .option("--json", "as JSON, for another program to read")
    .action(guarded(async (opts: { json?: boolean }) => {
      const { listProjects, formatStatus } = await import("./commands/status.js");
      if (opts.json) {
        console.log(JSON.stringify(listProjects()));
        return;
      }
      const { readCloud, cloudSummaries } = await import("./core/cloud.js");
      const cloudIds = new Set(Object.keys(readCloud()));
      if (cloudIds.size === 0) {
        console.log(formatStatus(listProjects()));
        return;
      }
      const { spriteCli } = await import("./core/sprite.js");
      // A cloud project pulled here for a check is a copy; its Sprite says how it is.
      const local = listProjects().filter((p) => !cloudIds.has(p.id));
      const cloud = (await cloudSummaries({ cli: spriteCli })) as unknown as typeof local;
      console.log(formatStatus([...local, ...cloud]));
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
    .option("--from <file>", "answers as JSON, {\"Q-001\": \"B\", …}; - reads stdin")
    .action(guarded(async (id: string, opts: { from?: string }) => {
      const { promptForAnswers, answerFrom } = await import("./commands/answer.js");
      if (!opts.from) return promptForAnswers(id);
      const fs = await import("node:fs");
      const given: unknown = JSON.parse(fs.readFileSync(opts.from === "-" ? 0 : opts.from, "utf8"));
      if (typeof given !== "object" || given === null || Object.values(given).some((v) => typeof v !== "string")) {
        throw new Error('--from must hold a JSON object of question id to answer text, like {"Q-001": "B"}');
      }
      console.log(answerFrom(id, given as Record<string, string>));
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

/** Commands about one project that run where it lives: on its Sprite, for a cloud project. */
const FORWARDED = new Set(["run", "answer", "feedback", "stop", "logs", "retry", "budget", "cost", "criteria", "why", "decisions", "slices", "stage"]);

export async function main(argv: string[] = process.argv): Promise<void> {
  await guarded(() => dispatch(argv))();
}

async function dispatch(argv: string[]): Promise<void> {
  const [command, id] = argv.slice(2);
  if (command && id && FORWARDED.has(command)) {
    const { cloudEntry, forward } = await import("./core/cloud.js");
    const entry = cloudEntry(id);
    if (entry) {
      const { spriteCli } = await import("./core/sprite.js");
      const args = argv.slice(2);
      // An answers file is on this machine; the command runs on the Sprite.
      const from = args.indexOf("--from");
      if (command === "answer" && from !== -1 && args[from + 1] && args[from + 1] !== "-") {
        const remote = `/tmp/sfo-answers-${id}.json`;
        await spriteCli.push(entry.sprite, args[from + 1], remote);
        args[from + 1] = remote;
      }
      process.exitCode = await forward(id, args, { cli: spriteCli });
      return;
    }
  }
  await buildProgram().parseAsync(argv);
}

if (isEntryPoint(process.argv[1], import.meta.url)) void main();
