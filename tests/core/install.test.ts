import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { commandNames, installTool, readInstall, reinstall, declaredInstall, type Exec } from "../../src/core/install.js";

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
    const name = args[3] ?? "";
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

  it("refuses a command name that is not a plain name, and never hands it to a shell", () => {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ bin: { "$(touch pwned)": "x.js", good: "y.js" } }));
    const { run, calls } = shell({ after: { good: "/usr/local/bin/good" } });
    const record = installTool("p", "cli-node", env, run);

    expect(record.commands).toContainEqual({ name: "$(touch pwned)", installed: false, detail: "not a plain command name; refused" });
    expect(calls.join("\n")).not.toContain("pwned");
    // The name travels as an argument after the script, not inside it.
    expect(calls.find((c) => c.includes("command -v"))).toBe('/bin/zsh -lc command -v -- "$1" sfo good');
  });
});


describe("reinstall, after a change", () => {
  function lastInstall(record: object | null) {
    fs.mkdirSync(path.join(dir, ".sfo"), { recursive: true });
    if (record) fs.writeFileSync(path.join(dir, ".sfo", "INSTALL.json"), JSON.stringify(record));
  }
  function needsMetFor(): boolean | undefined {
    let seen: boolean | undefined;
    reinstall("p", "cli-python", env, (_id, _a, _e, _r, needsMet) => {
      seen = needsMet;
      return { installer: null, commands: [], at: "" };
    });
    return seen;
  }

  it("installs again when sfo check had installed it, since the hardware was there", () => {
    lastInstall({ installer: "x", commands: [{ name: "soundscape --version", installed: true, detail: "" }], at: "" });
    expect(needsMetFor()).toBe(true);
  });

  it("keeps waiting when the install was still waiting for hardware", () => {
    lastInstall({ installer: "x", commands: [], at: "", deferred: ["hardware: a Mac"] });
    expect(needsMetFor()).toBe(false);
  });

  it("assumes nothing when it was never installed", () => {
    lastInstall(null);
    expect(needsMetFor()).toBe(false);
  });
});

describe("declaredInstall", () => {
  it("is the install and each check, as the project declared them", () => {
    fs.writeFileSync(
      path.join(dir, ".sfo", "CONTRACTS.json"),
      JSON.stringify({ gate: [{ name: "t", run: ["true"], files: "tests/{slice}*" }], install: { run: ["uv", "tool", "install", "."], check: [["moon", "--help"]] } }),
    );
    expect(declaredInstall("p", env)).toEqual([["uv", "tool", "install", "."], ["moon", "--help"]]);
  });

  it("is nothing to show without a contract", () => {
    expect(declaredInstall("p", env)).toBeNull();
  });
});
