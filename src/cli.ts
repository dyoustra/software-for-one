import { Command } from "commander";
import { randomBytes } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { createProject } from "./commands/new.js";
import { triage } from "./stages/triage.js";

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
    .argument("<idea>", "the idea, in your own words")
    .action(guarded(async (idea: string) => {
      const client = new Anthropic();
      const id = await createProject(
        idea,
        (text) => triage(text, client),
        randomBytes(3).toString("hex"),
      );
      console.log(`captured: ${id}`);
    }));

  program
    .command("run")
    .description("Advance a project until done or blocked")
    .argument("<id>", "project id")
    .option("--attach", "run in this process and stream progress")
    .action(guarded(async (id: string, opts: { attach?: boolean }) => {
      const { runAttached, runDetached, guardRunnable } = await import("./commands/run.js");
      guardRunnable(id);
      if (opts.attach) {
        await runAttached(id);
      } else {
        console.log(`started (pid ${runDetached(id)})`);
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
    .option("-f, --follow", "tail the log")
    .action(guarded(async (id: string, opts: { follow?: boolean }) => {
      const { showLogs } = await import("./commands/logs.js");
      showLogs(id, opts.follow ?? false);
    }));

  return program;
}

const isEntry = process.argv[1]?.endsWith("cli.ts") || process.argv[1]?.endsWith("cli.js");
if (isEntry) buildProgram().parse();
