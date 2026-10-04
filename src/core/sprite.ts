import { spawnSync } from "node:child_process";

/**
 * The Fly Sprites CLI, as sfo uses it. Everything that touches a Sprite goes
 * through here, so tests can stand in for it.
 */
export interface SpriteCli {
  create(name: string): void;
  destroy(name: string): void;
  /**
   * Runs `script` in a login shell on the Sprite, so its profile (PATH, the
   * credential sfo set up) applies. `args` reach it as "$1"…, never as script
   * text. `attach` hands it this terminal: prompts, editors and `-f` work.
   */
  exec(name: string, script: string, args?: string[], opts?: { input?: string; attach?: boolean }): { status: number; stdout: string };
  /** For anything large: exec's output is buffered, and 32 MB overflowed it. */
  pull(name: string, remote: string, local: string): void;
  push(name: string, local: string, remote: string): void;
}

function bin(): string {
  return process.env.SFO_SPRITE_BIN || "sprite";
}

function run(args: string[], what: string, input?: string): string {
  const r = spawnSync(bin(), args, { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`could not run the sprite CLI (${r.error.message}) — install it: https://docs.sprites.dev`);
  if (r.status !== 0) throw new Error(`${what} failed: ${`${r.stderr ?? ""}${r.stdout ?? ""}`.trim().split("\n").slice(-3).join(" ")}`);
  return r.stdout ?? "";
}

export const spriteCli: SpriteCli = {
  create(name) {
    run(["create", name, "--skip-console"], `creating Sprite ${name}`);
  },
  destroy(name) {
    run(["destroy", "-s", name, "--force"], `destroying Sprite ${name}`);
  },
  exec(name, script, args = [], opts = {}) {
    const argv = ["exec", "-s", name, ...(opts.attach && process.stdin.isTTY ? ["--tty"] : []), "--", "bash", "-lc", script, "sfo", ...args];
    if (opts.attach) {
      const r = spawnSync(bin(), argv, { stdio: "inherit" });
      if (r.error) throw new Error(`could not run the sprite CLI (${r.error.message})`);
      return { status: r.status ?? 1, stdout: "" };
    }
    const r = spawnSync(bin(), argv, { encoding: "utf8", input: opts.input ?? "", maxBuffer: 64 * 1024 * 1024 });
    if (r.error) throw new Error(`could not run the sprite CLI (${r.error.message})`);
    return { status: r.status ?? 1, stdout: `${r.stdout ?? ""}${r.status === 0 ? "" : (r.stderr ?? "")}` };
  },
  pull(name, remote, local) {
    run(["file", "pull", "-s", name, remote, local], `copying ${remote} from Sprite ${name}`);
  },
  push(name, local, remote) {
    run(["file", "push", "-s", name, local, remote], `copying ${local} to Sprite ${name}`);
  },
};
