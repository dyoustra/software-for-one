import { Command } from "commander";

export function buildProgram(): Command {
  const program = new Command();
  program.name("sfo").description("Software For One").version("0.1.0");

  program.command("new").description("Capture an idea and start a run");
  program.command("run").description("Advance a project");
  program.command("status").description("Show all projects");

  return program;
}

const isEntry = process.argv[1]?.endsWith("cli.ts") || process.argv[1]?.endsWith("cli.js");
if (isEntry) buildProgram().parse();
