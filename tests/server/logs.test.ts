import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { openDb } from "../../src/server/db.js";
import { createApp } from "../../src/server/app.js";
import { Vault, type GitHubOAuth } from "../../src/server/credentials.js";
import type { SpriteCli } from "../../src/core/sprite.js";
import type { LogPage } from "../../src/api/types.js";
import { noGitHubDevice } from "./fakes.js";

const ID = "moon-abc123";
let home: string;
let logs: string;

/** A Sprite whose exec runs the script for real, in a home of the test's own. */
const sprites: SpriteCli = {
  create: async () => {},
  destroy: async () => {},
  exec: async (_sprite, script, args = []) => {
    const r = spawnSync("bash", ["-c", script, "sfo", ...args], { env: { HOME: home, PATH: process.env.PATH }, encoding: "utf8" });
    return { status: r.status ?? 1, stdout: r.status === 0 ? r.stdout : `${r.stdout}${r.stderr}` };
  },
  pull: async () => {},
  push: async () => {},
};

const line = (o: object) => `${JSON.stringify(o)}\n`;
const say = (text: string) => line({ type: "assistant", message: { content: [{ type: "text", text }] } });
const run = (id: string, command: string) => line({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } });

function write(stage: string, text: string, ageS = 0) {
  const f = path.join(logs, `${stage}.log`);
  fs.writeFileSync(f, text);
  const t = Date.now() / 1000 - ageS;
  fs.utimesSync(f, t, t);
}

async function server() {
  const db = openDb(":memory:");
  const oauth: GitHubOAuth = { clientId: "x", authorizeUrl: () => "", whoami: async () => "x", exchange: async () => ({ accessToken: "", refreshToken: null, expiresAt: null }) };
  const app = createApp({ db, version: "t", verifyApple: async (t) => ({ sub: t }), allowed: new Set(["me", "you"]), publicUrl: "https://cp.test", vault: new Vault(db, randomBytes(32).toString("base64")), github: oauth, githubRedirects: [], sprites, githubDevice: noGitHubDevice, allowedGithub: new Set() });
  const signIn = async (who: string) =>
    ((await (await app.request("/auth/apple", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idToken: who }) })).json()) as { token: string }).token;
  const token = await signIn("me");
  const userId = (db.prepare("SELECT user_id FROM devices").get() as { user_id: string }).user_id;
  db.prepare("INSERT INTO projects (id, user_id, sprite, status, created_at, updated_at) VALUES (?, ?, 'sfo-00000000', 'ready', 't', 't')").run(ID, userId);
  const get = async (query: string, as = token) => {
    const res = await app.request(`/projects/${ID}/log${query}`, { headers: { authorization: `Bearer ${as}` } });
    return { status: res.status, page: (await res.json()) as LogPage };
  };
  return { get, signIn };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "sfo-logs-"));
  logs = path.join(home, ".sfo", ID, ".sfo", "logs");
  fs.mkdirSync(logs, { recursive: true });
});

describe("a project's log, a page at a time", () => {
  it("opens on the stage written last, listing every stage in order and leaving verify logs out", async () => {
    write("research", say("looking around"), 300);
    write("spec", say("writing it down"), 200);
    write("build-S-01.verify", "gate output\n", 50);
    write("build-S-01", say("first slice") + run("t1", "pytest -q"), 100);
    const s = await server();

    const { status, page } = await s.get("");
    expect(status).toBe(200);
    expect(page.stages.map((x) => x.name)).toEqual(["research", "spec", "build-S-01"]);
    expect(page.stage).toBe("build-S-01");
    expect(page.events).toEqual([{ kind: "say", text: "first slice" }, { kind: "run", target: "pytest -q", id: "t1" }]);
  });

  it("goes on from where the last page ended, with only what was written since", async () => {
    write("build-S-01", say("first"));
    const s = await server();
    const first = (await s.get("")).page;

    fs.appendFileSync(path.join(logs, "build-S-01.log"), say("second"));
    const next = (await s.get(`?stage=build-S-01&from=${first.to}`)).page;
    expect(next.events).toEqual([{ kind: "say", text: "second" }]);
    expect(next.from).toBe(first.to);
    expect((await s.get(`?stage=build-S-01&from=${next.to}`)).page.events).toEqual([]);
  });

  it("never hands over half a line: a line still being written waits for the next page", async () => {
    write("spec", say("whole") + '{"type":"assistant","mess');
    const s = await server();
    const page = (await s.get("?stage=spec&from=0")).page;
    expect(page.events).toEqual([{ kind: "say", text: "whole" }]);
    expect(page.to).toBe(Buffer.byteLength(say("whole")));
  });

  it("opens a long log at its end, from a whole line", async () => {
    const filler = say("x".repeat(1000));
    write("build-S-02", filler.repeat(100) + say("the latest"));
    const s = await server();
    const { page } = await s.get("");
    expect(page.from).toBeGreaterThan(0);
    expect(page.events.at(-1)).toEqual({ kind: "say", text: "the latest" });
    expect(page.events.every((e) => e.kind === "say")).toBe(true);
  });

  it("counts bytes, not characters, so the next page starts in the right place", async () => {
    write("spec", say("naïve — café"));
    const s = await server();
    const first = (await s.get("?stage=spec&from=0")).page;
    expect(first.to).toBe(Buffer.byteLength(say("naïve — café")));
    fs.appendFileSync(path.join(logs, "spec.log"), say("after"));
    expect((await s.get(`?stage=spec&from=${first.to}`)).page.events).toEqual([{ kind: "say", text: "after" }]);
  });

  it("refuses a stage that is not one of the project's logs, or is not a name", async () => {
    write("spec", say("x"));
    const s = await server();
    expect((await s.get("?stage=../../etc/passwd")).status).toBe(400);
    expect((await s.get("?stage=nope")).status).toBe(404);
    expect((await s.get("?from=-1")).status).toBe(400);
  });

  it("does not list or read a log that is a symlink", async () => {
    write("spec", say("real"));
    fs.writeFileSync(path.join(home, "secret.txt"), say("leaked"));
    fs.symlinkSync(path.join(home, "secret.txt"), path.join(logs, "build-S-01.log"));
    const s = await server();
    const { page } = await s.get("");
    expect(page.stages.map((x) => x.name)).toEqual(["spec"]);
    expect((await s.get("?stage=build-S-01")).status).toBe(404);
  });

  it("has no logs before the run starts", async () => {
    fs.rmSync(logs, { recursive: true });
    const s = await server();
    expect((await s.get("")).page).toEqual({ stages: [], stage: null, from: 0, to: 0, events: [] });
  });

  it("is its owner's alone", async () => {
    write("spec", say("x"));
    const s = await server();
    expect((await s.get("", await s.signIn("you"))).status).toBe(404);
  });
});
