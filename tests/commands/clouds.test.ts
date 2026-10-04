import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { openDb } from "../../src/server/db.js";
import { createApp } from "../../src/server/app.js";
import { Vault, type GitHubOAuth } from "../../src/server/credentials.js";
import { controlPlane, type CloudProjects } from "../../src/commands/clouds.js";
import type { SpriteCli } from "../../src/core/sprite.js";

const ID = "moon-abc123";
const calls: { script: string; args: string[]; input?: string }[] = [];
let origin: string;

/** A Sprite running sfo, as far as the CLI's commands reach it through the control plane. */
const sprites: SpriteCli = {
  create: async () => {},
  destroy: async () => {},
  async exec(_sprite, script, args = [], opts = {}) {
    calls.push({ script, args, input: opts.input });
    if (script.includes("sfo new")) return { status: 0, stdout: `captured: ${ID}\n` };
    if (script.includes("status --json")) return { status: 0, stdout: JSON.stringify([{ id: ID, title: "Moon", currentStage: "clarify", status: "awaiting_human" }]) };
    if (script.includes("git bundle create")) {
      execFileSync("git", ["bundle", "create", "-q", args[1], "--all"], { cwd: origin, stdio: "pipe" });
      return { status: 0, stdout: "" };
    }
    if (args[0] === "cost") return { status: 0, stdout: "TOTAL $1.95\n" };
    if (args[0] === "run") return { status: 0, stdout: "started (pid 7)" };
    return { status: 0, stdout: "answers saved" };
  },
  pull: async (_sprite, remote, local) => fs.copyFileSync(remote, local),
  push: async () => {},
};

let server: ServerType;
let cloud: CloudProjects;
let home: string;

beforeAll(async () => {
  origin = fs.mkdtempSync(path.join(os.tmpdir(), "sfo-origin-"));
  execFileSync("git", ["init", "-q"], { cwd: origin });
  fs.writeFileSync(path.join(origin, "README.md"), "moon\n");
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], { cwd: origin });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "one"], { cwd: origin });

  const db = openDb(":memory:");
  const vault = new Vault(db, randomBytes(32).toString("base64"));
  const oauth: GitHubOAuth = { clientId: "x", authorizeUrl: () => "", whoami: async () => "x", exchange: async () => ({ accessToken: "", refreshToken: null, expiresAt: null }) };
  const app = createApp({ db, version: "t", verifyApple: async (t) => ({ sub: t }), allowed: new Set(["me"]), publicUrl: "http://t", vault, github: oauth, githubRedirects: [], sprites });
  server = serve({ fetch: app.fetch, port: 0 });
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { token } = (await (await fetch(`${url}/auth/apple`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idToken: "me" }) })).json()) as { token: string };
  await fetch(`${url}/credentials/claude`, { method: "PUT", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ value: "sk-ant-oat01-x" }) });

  home = fs.mkdtempSync(path.join(os.tmpdir(), "sfo-home-"));
  cloud = controlPlane({ url, token }, { SFO_HOME: home });
});

afterAll(() => server.close());

describe("the CLI through the control plane", () => {
  it("creates a project, printing its progress as the server sets it up", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const profile = { modelAccess: ["claude_subscription" as const], apiKey: null, sfoPrefers: "claude_subscription" as const, fallbackToApiKey: false, subscriptionToken: null, githubToken: null, updatedAt: "" };
    expect(await cloud.create("tonight's moon", { run: true }, profile)).toBe(ID);
    expect(log.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/creating Sprite sfo-/);
    log.mockRestore();
  });

  it("lists it where status can show it, and knows it from a local project", async () => {
    const [row] = await cloud.list();
    expect(row).toMatchObject({ id: ID, status: "awaiting_human" });
    expect(row.note).toMatch(/^needs you · on sfo-/);
    expect(await cloud.has(ID)).toBe(true);
    expect(await cloud.has("lattice-000000")).toBe(false);
  });

  it("sends answers from a file, and runs and reports by command", async () => {
    const file = path.join(home, "answers.json");
    fs.writeFileSync(file, JSON.stringify({ "Q-001": "moon" }));
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(await cloud.command(ID, ["answer", ID, "--from", file])).toBe(0);
    expect(calls.find((c) => c.args[0] === "answer")?.input).toBe('{"Q-001":"moon"}');
    expect(await cloud.command(ID, ["cost", ID])).toBe(0);
    expect(out.mock.calls.map((c) => String(c[0])).join("")).toContain("TOTAL $1.95");

    out.mockRestore();
    log.mockRestore();
  });

  it("refuses what is not through the control plane yet, rather than doing something else", async () => {
    await expect(cloud.command(ID, ["logs", ID, "-f"])).rejects.toThrow(/not through the control plane yet/);
    await expect(cloud.command(ID, ["stage", ID, "spec"])).rejects.toThrow(/not available for a cloud project/);
  });

  it("treats being signed out as an error, never as \"not a cloud project\"", async () => {
    const address = server.address() as AddressInfo;
    const signedOut = controlPlane({ url: `http://127.0.0.1:${address.port}`, token: "sfo_revoked" }, { SFO_HOME: home });
    await expect(signedOut.has(ID)).rejects.toThrow(/sign in first/);
  });

  it("pulls a copy here from the project's bundle", async () => {
    const dir = await cloud.pull(ID);
    expect(dir).toBe(path.join(home, ID));
    expect(fs.readFileSync(path.join(dir, "README.md"), "utf8")).toBe("moon\n");
  });
});
