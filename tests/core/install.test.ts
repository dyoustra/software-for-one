import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { commandNames, installTool, readInstall, type Exec } from "../../src/core/install.js";

let env: Record<string, string>;
let dir: string;

beforeEach(() => {
  env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-install-")), SHELL: "/bin/zsh" };
  dir = path.join(env.SFO_HOME, "p");
  fs.mkdirSync(path.join(dir, ".sfo"), { recursive: true });
});

const pyproject = (scripts: string) =>
  fs.writeFileSync(path.join(dir, "pyproject.toml"), `[project]\nname = "ut-tower"\nversion = "0.1.0"\n\n[project.scripts]\n${scripts}\n\n[build-system]\nrequires = ["hatchling"]\n`);

/** A shell where `resolved` says what each name resolves to, before and after the install. */
function shell(opts: { before?: Record<string, string>; after?: Record<string, string>; runs?: boolean; installOk?: boolean }) {
  const calls: string[] = [];
  let installed = false;
  const run: Exec = (command, args) => {
    const line = [command, ...args].join(" ");
    calls.push(line);
    if (command === "uv" || command === "npm") {
      installed = opts.installOk ?? true;
      return { status: installed ? 0 : 1, output: installed ? "Installed" : "error: boom" };
    }
    const script = args[1] ?? "";
    const name = JSON.parse(script.replace(/^command -v -- /, "").replace(/ --help$/, ""));
    const table = installed ? (opts.after ?? {}) : (opts.before ?? {});
    if (script.startsWith("command -v")) return table[name] ? { status: 0, output: table[name] } : { status: 1, output: "" };
    return { status: opts.runs === false ? 1 : 0, output: "usage" };
  };
  return { run, calls };
}

describe("commandNames", () => {
  it("reads [project.scripts] and package.json bin", () => {
    pyproject('ut-tower = "ut_tower.cli:main"\nut-tower-debug = "ut_tower.cli:debug"');
    expect(commandNames(dir, "cli-python")).toEqual(["ut-tower", "ut-tower-debug"]);
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "@me/tool", bin: "dist/cli.js" }));
    expect(commandNames(dir, "cli-node")).toEqual(["tool"]);
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ bin: { a: "x.js", b: "y.js" } }));
    expect(commandNames(dir, "cli-node")).toEqual(["a", "b"]);
  });

  it("finds nothing to install without a manifest", () => {
    expect(commandNames(dir, "cli-python")).toEqual([]);
  });
});

describe("installTool", () => {
  it("installs, then confirms the command resolves and runs from a new login shell", () => {
    pyproject('ut-tower = "ut_tower.cli:main"');
    const { run, calls } = shell({ after: { "ut-tower": "/Users/me/.local/bin/ut-tower" } });
    const record = installTool("p", "cli-python", env, run);

    expect(record.installer).toBe(`uv tool install --editable --force ${dir}`);
    expect(record.commands).toEqual([{ name: "ut-tower", installed: true, detail: "/Users/me/.local/bin/ut-tower" }]);
    expect(calls.some((c) => c.startsWith("/bin/zsh -lc"))).toBe(true);
    expect(readInstall("p", env)?.commands[0].installed).toBe(true);
  });

  it("never replaces a command someone else owns", () => {
    pyproject('ut-tower = "ut_tower.cli:main"');
    const { run, calls } = shell({ before: { "ut-tower": "/opt/homebrew/bin/ut-tower" } });
    const record = installTool("p", "cli-python", env, run);

    expect(calls.some((c) => c.startsWith("uv "))).toBe(false);
    expect(record.commands[0]).toMatchObject({ installed: false, detail: expect.stringMatching(/already taken by \/opt\/homebrew\/bin\/ut-tower/) });
  });

  it("reinstalls over its own earlier install", () => {
    pyproject('ut-tower = "ut_tower.cli:main"');
    const ours = "/Users/me/.local/share/uv/tools/ut-tower/bin/ut-tower";
    const { run, calls } = shell({ before: { "ut-tower": ours }, after: { "ut-tower": ours } });
    expect(installTool("p", "cli-python", env, run).commands[0].installed).toBe(true);
    expect(calls.some((c) => c.startsWith("uv tool install"))).toBe(true);
  });

  it("says so when the command is installed but does not run", () => {
    pyproject('ut-tower = "ut_tower.cli:main"');
    const { run } = shell({ after: { "ut-tower": "/Users/me/.local/bin/ut-tower" }, runs: false });
    expect(installTool("p", "cli-python", env, run).commands[0]).toMatchObject({ installed: false, detail: expect.stringMatching(/does not run/) });
  });

  it("reports an installer failure per command", () => {
    pyproject('ut-tower = "ut_tower.cli:main"');
    const { run } = shell({ installOk: false });
    expect(installTool("p", "cli-python", env, run).commands[0]).toMatchObject({ installed: false, detail: expect.stringMatching(/installer failed: error: boom/) });
  });
});
