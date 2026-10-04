import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  newCloudProject,
  forward,
  cloudSummaries,
  cloudEntry,
  destroyCloudProject,
  pullProject,
  readCloud,
  type GitHub,
} from "../../src/core/cloud.js";
import type { SpriteCli } from "../../src/core/sprite.js";
import type { Profile } from "../../src/core/access.js";

let env: Record<string, string>;

type Exec = { name: string; script: string; args: string[]; input?: string; attach?: boolean };

/** Stands in for the sprite CLI. `reply` decides what each exec prints. */
class FakeSprite implements SpriteCli {
  created: string[] = [];
  destroyed: string[] = [];
  execs: Exec[] = [];
  pulls: [string, string][] = [];
  constructor(private readonly reply: (e: Exec) => { status: number; stdout: string } = () => ({ status: 0, stdout: "" })) {}
  create(name: string) {
    this.created.push(name);
  }
  destroy(name: string) {
    this.destroyed.push(name);
  }
  exec(name: string, script: string, args: string[] = [], opts: { input?: string; attach?: boolean } = {}) {
    const e = { name, script, args, ...opts };
    this.execs.push(e);
    return this.reply(e);
  }
  pull(_name: string, remote: string, local: string) {
    this.pulls.push([remote, local]);
    fs.copyFileSync(remote, local);
  }
  push() {}
}

const PROFILE: Profile = {
  modelAccess: ["claude_subscription"],
  apiKey: null,
  sfoPrefers: "claude_subscription",
  fallbackToApiKey: false,
  subscriptionToken: { source: "keychain", service: "claude-oauth-token" },
  githubToken: null,
  updatedAt: "2026-10-03T00:00:00.000Z",
};

const TOKEN = "sk-ant-oat-secret";
const keys = (ref: { source: string }) => (ref.source === "keychain" ? TOKEN : null);

/** A Sprite whose sfo captures `id` and reports it as `status`. */
function capturing(id: string, status = "awaiting_human", extra = "") {
  return (e: Exec) => {
    if (e.script.includes("sfo new")) return { status: 0, stdout: `captured: ${id}\nestimated front: $1–$2\n${extra}` };
    if (e.script.includes("status --json")) {
      return { status: 0, stdout: JSON.stringify([{ id, title: "T", currentStage: "research", status }]) };
    }
    return { status: 0, stdout: "" };
  };
}

const quiet = () => {};

beforeEach(() => {
  env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-cloud-")) };
});

describe("a new cloud project", () => {
  it("gets a Sprite of its own, set up, with the credential sent on stdin and never as an argument", async () => {
    const sprite = new FakeSprite(capturing("tiny-abc123"));
    const id = await newCloudProject("an idea", { run: true }, PROFILE, { cli: sprite, env, readKeyWith: keys, log: quiet });

    expect(id).toBe("tiny-abc123");
    expect(sprite.created).toHaveLength(1);
    const name = sprite.created[0];
    expect(name).toMatch(/^sfo-[0-9a-f]{8}$/);

    const stored = sprite.execs.find((e) => e.input === TOKEN);
    expect(stored?.args).toEqual(["claude-token"]);
    for (const e of sprite.execs) {
      expect([e.script, ...e.args].join(" ")).not.toContain(TOKEN);
    }
    const setup = sprite.execs[0];
    expect(setup.args[0]).toBe("https://github.com/dyoustra/software-for-one.git");
    expect(JSON.parse(setup.args[1])).toMatchObject({ modelAccess: ["claude_subscription"], sfoPrefers: "claude_subscription" });

    const capture = sprite.execs.find((e) => e.script.includes("sfo new"));
    expect(capture?.args).toEqual(["an idea", "--local", "--no-run"]);
    expect(sprite.execs.some((e) => e.script.includes("sfo run") && e.args[0] === id)).toBe(true);
    expect(cloudEntry(id, env)).toMatchObject({ sprite: name, repo: null, summary: { status: "awaiting_human" } });
  });

  it("leaves the API key behind when the plan is preferred and there is no fallback", async () => {
    const sprite = new FakeSprite(capturing("tiny-abc123"));
    const profile: Profile = {
      ...PROFILE,
      modelAccess: ["claude_subscription", "anthropic_api_key"],
      apiKey: { source: "env", var: "KEY" },
    };
    const both = (ref: { source: string }) => (ref.source === "keychain" ? TOKEN : "sk-ant-api-key");
    await newCloudProject("an idea", { run: false }, profile, { cli: sprite, env, readKeyWith: both, log: quiet });

    expect(sprite.execs.filter((e) => e.input).map((e) => e.args[0])).toEqual(["claude-token"]);
    expect(JSON.parse(sprite.execs[0].args[1]).modelAccess).toEqual(["claude_subscription"]);
  });

  it("refuses before creating anything when no credential can travel", async () => {
    const sprite = new FakeSprite();
    await expect(
      newCloudProject("an idea", { run: true }, { ...PROFILE, subscriptionToken: null }, { cli: sprite, env, readKeyWith: keys, log: quiet }),
    ).rejects.toThrow(/claude setup-token/);
    expect(sprite.created).toEqual([]);
  });

  it("destroys the Sprite it made when capture fails, so none is left behind", async () => {
    const sprite = new FakeSprite((e) => (e.script.includes("sfo new") ? { status: 1, stdout: "triage failed" } : { status: 0, stdout: "" }));
    await expect(newCloudProject("an idea", { run: true }, PROFILE, { cli: sprite, env, readKeyWith: keys, log: quiet })).rejects.toThrow(
      /capture failed/,
    );
    expect(sprite.destroyed).toEqual(sprite.created);
    expect(readCloud(env)).toEqual({});
  });

  it("does not start what triage called out of scope", async () => {
    const sprite = new FakeSprite(capturing("big-abc123", "awaiting_human", "triage: out of scope — it could build this instead: less"));
    await newCloudProject("an idea", { run: true }, PROFILE, { cli: sprite, env, readKeyWith: keys, log: quiet });
    expect(sprite.execs.some((e) => e.script.includes("sfo run"))).toBe(false);
  });

  it("gets a private repo when there is a GitHub token, which never reaches the Sprite", async () => {
    const GH_TOKEN = "ghp_secret";
    const sprite = new FakeSprite((e) =>
      e.script.includes("ssh-keygen") ? { status: 0, stdout: "ssh-ed25519 AAAA sfo tiny-abc123\n" } : capturing("tiny-abc123")(e),
    );
    const made: string[] = [];
    const keys: string[] = [];
    const gh: GitHub = {
      login: async () => "someone",
      createPrivateRepo: async (_t, name) => (made.push(name), `https://github.com/someone/${name}`),
      addDeployKey: async (_t, owner, repo, key) => void keys.push(`${owner}/${repo} ${key}`),
    };
    const ghKeys = (ref: { source: string; service?: string }) => (ref.service === "github-token" ? GH_TOKEN : TOKEN);
    const profile = { ...PROFILE, githubToken: { source: "keychain" as const, service: "github-token" } };
    await newCloudProject("an idea", { run: false }, profile, { cli: sprite, env, readKeyWith: ghKeys, github: gh, log: quiet });

    expect(made).toEqual(["tiny-abc123"]);
    expect(keys).toEqual(["someone/tiny-abc123 ssh-ed25519 AAAA sfo tiny-abc123"]);
    expect(cloudEntry("tiny-abc123", env)?.repo).toBe("https://github.com/someone/tiny-abc123");
    const wired = sprite.execs.find((e) => e.script.includes("git remote add origin"));
    expect(wired?.args).toEqual(["tiny-abc123", "git@github.com:someone/tiny-abc123.git"]);
    for (const e of sprite.execs) expect([e.script, ...e.args, e.input ?? ""].join(" ")).not.toContain(GH_TOKEN);
  });

  it("still builds when GitHub fails: the repo is optional", async () => {
    const sprite = new FakeSprite(capturing("tiny-abc123"));
    const gh: GitHub = {
      login: async () => "someone",
      createPrivateRepo: async () => {
        throw new Error("422");
      },
      addDeployKey: async () => {},
    };
    const profile = { ...PROFILE, githubToken: { source: "keychain" as const, service: "github-token" } };
    const said: string[] = [];
    await newCloudProject("an idea", { run: true }, profile, { cli: sprite, env, readKeyWith: keys, github: gh, log: (m) => said.push(m) });

    expect(cloudEntry("tiny-abc123", env)?.repo).toBeNull();
    expect(said.join("\n")).toMatch(/no GitHub repo for this project/);
    expect(sprite.execs.some((e) => e.script.includes("sfo run"))).toBe(true);
  });
});

describe("a cloud project afterwards", () => {
  async function made(status = "awaiting_human"): Promise<FakeSprite> {
    const sprite = new FakeSprite(capturing("tiny-abc123", status));
    await newCloudProject("an idea", { run: false }, PROFILE, { cli: sprite, env, readKeyWith: keys, log: quiet });
    sprite.execs = [];
    return sprite;
  }

  it("runs its commands on its Sprite, attached to this terminal", async () => {
    const sprite = await made();
    forward("tiny-abc123", ["answer", "tiny-abc123"], { cli: sprite, env });
    expect(sprite.execs[0]).toMatchObject({ script: 'exec sfo "$@"', args: ["answer", "tiny-abc123"], attach: true });
  });

  it("asks a Sprite how its project is only while the project is running", async () => {
    const waiting = await made("awaiting_human");
    cloudSummaries({ cli: waiting, env });
    expect(waiting.execs).toEqual([]);

    env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-cloud-")) };
    const running = await made("running");
    const [summary] = cloudSummaries({ cli: running, env });
    expect(running.execs.map((e) => e.script)).toEqual(["exec sfo status --json"]);
    expect(summary.note).toMatch(/^on sfo-/);
  });

  it("finds no cloud project behind a built-in name", () => {
    expect(cloudEntry("constructor", env)).toBeNull();
    expect(cloudEntry("__proto__", env)).toBeNull();
  });

  it("forgets the project once its Sprite is destroyed", async () => {
    const sprite = await made();
    const name = cloudEntry("tiny-abc123", env)!.sprite;
    destroyCloudProject("tiny-abc123", { cli: sprite, env });
    expect(sprite.destroyed).toEqual([name]);
    expect(cloudEntry("tiny-abc123", env)).toBeNull();
  });

  it("pulls a copy here as a git clone, and updates it on the next pull", async () => {
    const origin = fs.mkdtempSync(path.join(os.tmpdir(), "sfo-sprite-side-"));
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: origin, stdio: "pipe" });
    git("init", "-q");
    fs.writeFileSync(path.join(origin, "a.txt"), "1\n");
    git("add", "-A");
    git("commit", "-q", "-m", "one");

    const sprite = new FakeSprite((e) => {
      if (e.script.includes("git bundle create")) {
        execFileSync("git", ["bundle", "create", "-q", e.args[1], "--all"], { cwd: origin, stdio: "pipe" });
      }
      return capturing("tiny-abc123")(e);
    });
    await newCloudProject("an idea", { run: false }, PROFILE, { cli: sprite, env, readKeyWith: keys, log: quiet });

    const dir = pullProject("tiny-abc123", { cli: sprite, env });
    expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("1\n");

    fs.writeFileSync(path.join(origin, "a.txt"), "2\n");
    git("commit", "-q", "-am", "two");
    pullProject("tiny-abc123", { cli: sprite, env });
    expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("2\n");
  });
});
