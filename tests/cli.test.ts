import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildProgram, isEntryPoint } from "../src/cli.js";

describe("buildProgram", () => {
  it("registers the expected commands", () => {
    const names = buildProgram().commands.map((c) => c.name());
    expect(names).toContain("new");
    expect(names).toContain("run");
    expect(names).toContain("status");
    expect(names).toContain("answer");
    expect(names).toContain("stage");
    expect(names).toContain("cost");
    expect(names).toContain("criteria");
    expect(names).toContain("decisions");
    expect(names).toContain("why");
  });

  it("offers an explicit override for the prior-art verdict", () => {
    const run = buildProgram().commands.find((c) => c.name() === "run");
    expect(run?.options.map((o) => o.long)).toContain("--anyway");
  });

  it("registers profile, and the access flags on new and run", () => {
    const program = buildProgram();
    expect(program.commands.map((c) => c.name())).toContain("profile");
    const flags = (name: string) =>
      program.commands.find((c) => c.name() === name)?.options.map((o) => o.long);
    expect(flags("new")).toContain("--access");
    expect(flags("run")).toContain("--use-api-key");
    expect(flags("budget")).toContain("--billed-only");
  });

  it("registers stop, and lets new hold the run", () => {
    const program = buildProgram();
    expect(program.commands.map((c) => c.name())).toContain("stop");
    const newCmd = program.commands.find((c) => c.name() === "new");
    expect(newCmd?.options.map((o) => o.long)).toContain("--no-run");
  });
});


describe("isEntryPoint", () => {
  it("recognises the program through a symlink, as the installed sfo is", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sfo-entry-"));
    const real = path.join(dir, "cli.js");
    fs.writeFileSync(real, "");
    const link = path.join(dir, "sfo");
    fs.symlinkSync(real, link);

    expect(isEntryPoint(link, pathToFileURL(real).href)).toBe(true);
    expect(isEntryPoint(path.join(dir, "other.js"), pathToFileURL(real).href)).toBe(false);
    expect(isEntryPoint(undefined, pathToFileURL(real).href)).toBe(false);
  });
});

describe("contract commands", () => {
  it("registers check and prefs, still reachable as preferences", () => {
    const commands = buildProgram().commands;
    expect(commands.map((c) => c.name())).toEqual(expect.arrayContaining(["check", "prefs"]));
    expect(commands.find((c) => c.name() === "prefs")?.aliases()).toContain("preferences");
  });
});

