import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { artifactPath, projectDir, sfoDir, type Env } from "./paths.js";
import { readContractFile, type Contract } from "./contracts.js";

export const INSTALL_FILE = "INSTALL.json";

export interface InstalledCommand {
  name: string;
  installed: boolean;
  /** Where it resolves from a fresh shell, or why it is not installed. */
  detail: string;
}

export interface InstallRecord {
  installer: string | null;
  commands: InstalledCommand[];
  /** What the install needs that the run did not have, when it was left for later. */
  deferred?: string[];
  at: string;
}

export type Exec = (command: string, args: string[], opts: { cwd?: string; timeoutMs: number }) => { status: number | null; output: string };

export const exec: Exec = (command, args, { cwd, timeoutMs }) => {
  const r = spawnSync(command, args, { cwd, encoding: "utf8", timeout: timeoutMs });
  return { status: r.error ? null : r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
};

/** Command names a project declares, read from its manifest without a TOML parser. */
export function commandNames(dir: string, archetype: string): string[] {
  try {
    if (archetype === "cli-node") {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { name?: string; bin?: string | Record<string, string> };
      if (typeof pkg.bin === "string") return pkg.name ? [pkg.name.replace(/^@[^/]+\//, "")] : [];
      return pkg.bin ? Object.keys(pkg.bin) : [];
    }
    if (archetype === "cli-python") {
      const text = fs.readFileSync(path.join(dir, "pyproject.toml"), "utf8");
      const section = text.split(/^\[project\.scripts\]\s*$/m)[1]?.split(/^\[/m)[0] ?? "";
      return [...section.matchAll(/^\s*["']?([A-Za-z0-9._-]+)["']?\s*=/gm)].map((m) => m[1]);
    }
  } catch {
    // No manifest: nothing to install.
  }
  return [];
}

function packageName(dir: string, archetype: string): string | null {
  if (archetype !== "cli-python") return null;
  try {
    const text = fs.readFileSync(path.join(dir, "pyproject.toml"), "utf8");
    const project = text.split(/^\[project\]\s*$/m)[1]?.split(/^\[/m)[0] ?? "";
    return project.match(/^\s*name\s*=\s*["']([^"']+)["']/m)?.[1] ?? null;
  } catch {
    return null;
  }
}

const SHELL_TIMEOUT_MS = 30_000;

/**
 * A command name as a person would type one. Names come from a manifest an
 * agent wrote, so anything else is refused rather than handed to a shell.
 */
export const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * What a person's new terminal would find for `name`, and whether it runs.
 * The name reaches the shell only as a positional argument (`$1`), never as
 * script text: inside a quoted script string `$(…)` would still execute.
 */
function fromFreshShell(name: string, run: Exec, env: Env): { path: string | null; runs: boolean; output: string } {
  const shell = env.SHELL || "/bin/zsh";
  const where = run(shell, ["-lc", 'command -v -- "$1"', "sfo", name], { timeoutMs: SHELL_TIMEOUT_MS });
  if (where.status !== 0 || !where.output) return { path: null, runs: false, output: where.output };
  const resolved = where.output.split("\n").at(-1) ?? "";
  const help = run(shell, ["-lc", '"$1" --help', "sfo", name], { timeoutMs: SHELL_TIMEOUT_MS });
  return { path: resolved, runs: help.status === 0, output: help.output };
}

function realpathOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Puts the tool on the person's PATH and checks it from a fresh login shell,
 * which is the only check that means anything: sfo's own command passed every
 * test and did nothing when typed. Never replaces a command it did not
 * install; a name already taken is reported, not overwritten.
 */
export function installTool(
  id: string,
  archetype: string,
  env: Env = process.env,
  run: Exec = exec,
  /** `sfo check`: the person confirmed what a deferred install needs is here. */
  needsMet = false,
): InstallRecord {
  const dir = projectDir(id, env);
  const contracted = readContractFile(id, env)?.install;
  if (contracted) return installDeclared(id, dir, contracted, env, run, needsMet);
  const declared = commandNames(dir, archetype);
  const names = declared.filter((n) => COMMAND_NAME.test(n));
  const record: InstallRecord = { installer: null, commands: [], at: new Date().toISOString() };
  for (const bad of declared.filter((n) => !COMMAND_NAME.test(n))) {
    record.commands.push({ name: bad, installed: false, detail: "not a plain command name; refused" });
  }
  if (names.length === 0) return save(id, record, env);

  // Ours only if it points into this project or this project's own uv tool
  // environment. Any other uv tool with the same command name is someone
  // else's, and --force would overwrite it.
  const pkg = packageName(dir, archetype);
  const isOurs = (resolved: string): boolean => {
    const real = realpathOr(resolved);
    return real.startsWith(`${realpathOr(dir)}/`) || (pkg !== null && real.includes(`/uv/tools/${pkg}/`));
  };
  const taken = names.flatMap((name) => {
    const before = fromFreshShell(name, run, env);
    return before.path && !isOurs(before.path) ? [{ name, installed: false, detail: `the name is already taken by ${before.path}; not replaced` }] : [];
  });

  const installer =
    archetype === "cli-python"
      ? { command: "uv", args: ["tool", "install", "--editable", "--force", dir] }
      : archetype === "cli-node"
        ? { command: "npm", args: ["link"] }
        : null;
  if (!installer || taken.length === names.length) {
    record.commands = taken.length > 0 ? taken : names.map((name) => ({ name, installed: false, detail: `no installer for "${archetype}"` }));
    return save(id, record, env);
  }

  record.installer = [installer.command, ...installer.args].join(" ");
  const done = run(installer.command, installer.args, { cwd: dir, timeoutMs: 300_000 });
  for (const name of names) {
    const skipped = taken.find((t) => t.name === name);
    if (skipped) {
      record.commands.push(skipped);
      continue;
    }
    if (done.status !== 0) {
      record.commands.push({ name, installed: false, detail: `the installer failed: ${done.output.split("\n").slice(-3).join(" ")}` });
      continue;
    }
    const after = fromFreshShell(name, run, env);
    record.commands.push(
      after.path && after.runs
        ? { name, installed: true, detail: after.path }
        : { name, installed: false, detail: after.path ? `${after.path} does not run: ${after.output.split("\n").slice(-2).join(" ")}` : "not found from a new terminal after installing" },
    );
  }
  return save(id, record, env);
}

/**
 * The project's own install: whatever "where the person uses it" means for it
 * — a command on PATH, an unpacked extension, firmware on a board. Each check
 * runs from a fresh login shell, with its arguments passed as data.
 */
function installDeclared(
  id: string,
  dir: string,
  declared: NonNullable<Contract["install"]>,
  env: Env,
  run: Exec,
  needsMet: boolean,
): InstallRecord {
  const record: InstallRecord = { installer: declared.run.join(" "), commands: [], at: new Date().toISOString() };
  if (declared.needs.length > 0 && !needsMet) return save(id, { ...record, deferred: declared.needs }, env);

  const done = run(declared.run[0], declared.run.slice(1), { cwd: dir, timeoutMs: 300_000 });
  if (done.status !== 0) {
    record.commands.push({ name: declared.run.join(" "), installed: false, detail: `the install failed: ${done.output.split("\n").slice(-3).join(" ")}` });
    return save(id, record, env);
  }
  const shell = env.SHELL || "/bin/zsh";
  for (const check of declared.check) {
    const r = run(shell, ["-lc", '"$@"', "sfo", ...check], { timeoutMs: SHELL_TIMEOUT_MS });
    record.commands.push({
      name: check.join(" "),
      installed: r.status === 0,
      detail: r.status === 0 ? "runs from a new terminal" : `exited ${r.status ?? "abnormally"}: ${r.output.split("\n").slice(-2).join(" ")}`,
    });
  }
  return save(id, record, env);
}

function save(id: string, record: InstallRecord, env: Env): InstallRecord {
  fs.mkdirSync(sfoDir(id, env), { recursive: true });
  fs.writeFileSync(artifactPath(id, INSTALL_FILE, env), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/**
 * Puts a changed project back where the person uses it, as it was last put
 * there. An install that waited for hardware and was then done by \`sfo check\`
 * had the hardware; without carrying that over, every later change would
 * record the install as waiting again, with the tool still installed.
 */
export function reinstall(id: string, archetype: string, env: Env = process.env, install = installTool): InstallRecord {
  const last = readInstall(id, env);
  const wasDone = last !== null && !last.deferred && last.commands.some((c) => c.installed);
  return install(id, archetype, env, exec, wasDone);
}

/**
 * What installing this project runs, as it declared it: the install, then
 * each check. Null without a contract, when the built-in installer would run
 * instead and could not be shown as a command.
 */
export function declaredInstall(id: string, env?: Env): string[][] | null {
  const install = readContractFile(id, env)?.install;
  return install ? [install.run, ...install.check] : null;
}

export function readInstall(id: string, env?: Env): InstallRecord | null {
  try {
    return JSON.parse(fs.readFileSync(artifactPath(id, INSTALL_FILE, env), "utf8")) as InstallRecord;
  } catch {
    return null;
  }
}
