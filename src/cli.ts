import { Command } from "commander";
import { randomBytes } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { createProject } from "./commands/new.js";
import { triage } from "./stages/triage.js";

export function buildProgram(): Command {
  const program = new Command();
  program.name("sfo").description("Software For One").version("0.1.0");

  program
    .command("new")
    .description("Capture an idea and start a run")
    .argument("<idea>", "the idea, in your own words")
    .action(async (idea: string) => {
      const client = new Anthropic();
      const id = await createProject(
        idea,
        (text) => triage(text, client),
        randomBytes(3).toString("hex"),
      );
      console.log(`captured: ${id}`);
    });

  program.command("run").description("Advance a project");
  program.command("status").description("Show all projects");

  return program;
}

const isEntry = process.argv[1]?.endsWith("cli.ts") || process.argv[1]?.endsWith("cli.js");
if (isEntry) buildProgram().parse();
