import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { openDb } from "../../src/server/db.js";
import { createApp } from "../../src/server/app.js";
import { Vault, type GitHubOAuth } from "../../src/server/credentials.js";
import type { SpriteCli } from "../../src/core/sprite.js";

type Call = { sprite: string; script: string; args: string[]; input?: string };

/** Sprites that run sfo as far as these tests need: capture, status, questions, answers. */
function fakeSprites() {
  const calls: Call[] = [];
  const created: string[] = [];
  const destroyed: string[] = [];
  const sprites: SpriteCli = {
    create: async (name) => void created.push(name),
    destroy: async (name) => void destroyed.push(name),
    exec: async (sprite, script, args = [], opts = {}) => {
      calls.push({ sprite, script, args, input: opts.input });
      if (script.includes("sfo new")) return { status: 0, stdout: "captured: moon-abc123\nestimated front: $1–$2\n" };
      if (script.includes("status --json")) return { status: 0, stdout: JSON.stringify([{ id: "moon-abc123", title: "Moon", currentStage: "clarify", status: "awaiting_human" }]) };
      if (args[0] === "questions") return { status: 0, stdout: JSON.stringify([{ id: "Q-001", text: "Name?" }]) };
      if (args[0] === "answer") return { status: 0, stdout: "answers saved" };
      if (args[0] === "run") return { status: 0, stdout: "started (pid 7)" };
      return { status: 0, stdout: "" };
    },
    pull: async () => {},
    push: async () => {},
  };
  return { sprites, calls, created, destroyed };
}

function server() {
  const db = openDb(":memory:");
  const vault = new Vault(db, randomBytes(32).toString("base64"));
  const fake = fakeSprites();
  const oauth: GitHubOAuth = { clientId: "x", authorizeUrl: () => "", whoami: async () => "x", exchange: async () => ({ accessToken: "", refreshToken: null, expiresAt: null }) };
  const app = createApp({ db, version: "t", verifyApple: async (t) => ({ sub: t }), allowed: new Set(["me", "you"]), publicUrl: "https://cp.test", vault, github: oauth, githubRedirects: [], sprites: fake.sprites });
  const call = (method: string, path: string, token?: string, body?: unknown) =>
    app.request(path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const signIn = async (who: string) => ((await (await call("POST", "/auth/apple", undefined, { idToken: who })).json()) as { token: string }).token;
  return { db, vault, fake, call, signIn };
}

async function withProject(s: ReturnType<typeof server>, who = "me") {
  const token = await s.signIn(who);
  await s.call("PUT", "/credentials/claude", token, { value: "sk-ant-oat01-secret" });
  const res = await s.call("POST", "/projects", token, { idea: "tonight's moon" });
  const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  return { token, lines };
}

describe("creating a project", () => {
  it("provisions a Sprite inside the request, reporting each step, and records the project", async () => {
    const s = server();
    const { token, lines } = await withProject(s);

    expect(lines.some((l) => typeof l.progress === "string" && /creating Sprite sfo-/.test(l.progress))).toBe(true);
    const done = lines.at(-1) as { done: boolean; project: { id: string; sprite: string; summary: { status: string } } };
    expect(done.done).toBe(true);
    expect(done.project).toMatchObject({ id: "moon-abc123", sprite: s.fake.created[0], summary: { status: "awaiting_human" } });
    expect(((await (await s.call("GET", "/projects", token)).json()) as { id: string }[]).map((p) => p.id)).toEqual(["moon-abc123"]);
  });

  it("gives the Sprite the stored credential on stdin, never in a command", async () => {
    const s = server();
    await withProject(s);
    expect(s.fake.calls.find((c) => c.args[0] === "claude-token")?.input).toBe("sk-ant-oat01-secret");
    for (const c of s.fake.calls) expect([c.script, ...c.args].join(" ")).not.toContain("sk-ant-oat01-secret");
  });

  it("refuses before making anything when no model credential is stored", async () => {
    const s = server();
    const token = await s.signIn("me");
    expect((await s.call("POST", "/projects", token, { idea: "x" })).status).toBe(400);
    expect(s.fake.created).toEqual([]);
  });
});

describe("a project", () => {
  it("is its owner's alone: anyone else gets no such project", async () => {
    const s = server();
    await withProject(s, "me");
    const yours = await s.signIn("you");
    for (const path of ["/projects/moon-abc123", "/projects/moon-abc123/questions"]) {
      expect((await s.call("GET", path, yours)).status).toBe(404);
    }
    expect((await s.call("DELETE", "/projects/moon-abc123", yours)).status).toBe(404);
    expect(s.fake.destroyed).toEqual([]);
  });

  it("shows its open questions, and takes every answer at once then resumes", async () => {
    const s = server();
    const { token } = await withProject(s);
    expect(await (await s.call("GET", "/projects/moon-abc123/questions", token)).json()).toEqual([{ id: "Q-001", text: "Name?" }]);

    const res = await s.call("POST", "/projects/moon-abc123/answers", token, { "Q-001": "moon" });
    expect(await res.json()).toMatchObject({ ok: true, resumed: true });
    const answer = s.fake.calls.find((c) => c.args[0] === "answer");
    expect(answer).toMatchObject({ args: ["answer", "moon-abc123", "--from", "-"], input: '{"Q-001":"moon"}' });
    expect(s.fake.calls.at(-1)?.args).toEqual(["run", "moon-abc123"]);
  });

  it("refuses answers that are not text", async () => {
    const s = server();
    const { token } = await withProject(s);
    expect((await s.call("POST", "/projects/moon-abc123/answers", token, { "Q-001": 3 })).status).toBe(400);
  });

  it("passes feedback to sfo as an argument, not as script", async () => {
    const s = server();
    const { token } = await withProject(s);
    await s.call("POST", "/projects/moon-abc123/feedback", token, { text: "make it $(rm -rf ~) smaller" });
    const fb = s.fake.calls.find((c) => c.args[0] === "feedback");
    expect(fb?.script).toBe('cd ~ && exec sfo "$@"');
    expect(fb?.args).toEqual(["feedback", "moon-abc123", "make it $(rm -rf ~) smaller"]);
  });

  it("builds past research's verdict only when asked to", async () => {
    const s = server();
    const { token } = await withProject(s);
    await s.call("POST", "/projects/moon-abc123/run", token, {});
    expect(s.fake.calls.at(-1)?.args).toEqual(["run", "moon-abc123"]);
    await s.call("POST", "/projects/moon-abc123/run", token, { anyway: true });
    expect(s.fake.calls.at(-1)?.args).toEqual(["run", "moon-abc123", "--anyway"]);
  });

  it("reports only what cannot change it", async () => {
    const s = server();
    const { token } = await withProject(s);
    expect((await s.call("GET", "/projects/moon-abc123/report/cost", token)).status).toBe(200);
    expect(s.fake.calls.at(-1)?.args).toEqual(["cost", "moon-abc123"]);
    expect((await s.call("GET", "/projects/moon-abc123/report/destroy", token)).status).toBe(400);
  });

  it("goes with its Sprite when destroyed", async () => {
    const s = server();
    const { token } = await withProject(s);
    expect((await s.call("DELETE", "/projects/moon-abc123", token)).status).toBe(200);
    expect(s.fake.destroyed).toEqual(s.fake.created);
    expect(await (await s.call("GET", "/projects", token)).json()).toEqual([]);
  });
});

describe("importing a project made before the control plane", () => {
  /** The person writes the challenge onto the Sprite with their own access; here, the fake holds it. */
  function holding(s: ReturnType<typeof server>, sprite: string, proof: () => string) {
    const exec = s.fake.sprites.exec;
    s.fake.sprites.exec = async (name, script, args, opts) =>
      script.startsWith("cat ~/.sfo/") ? (name === sprite ? { status: 0, stdout: `${proof()}\n` } : { status: 1, stdout: "" }) : exec(name, script, args, opts);
  }

  it("is kept once the Sprite holds the challenge, written there with the person's own access", async () => {
    const s = server();
    const token = await s.signIn("me");
    const ch = (await (await s.call("POST", "/projects/import/challenge", token, { id: "moon-abc123", sprite: "sfo-0123abcd" })).json()) as { nonce: string };
    holding(s, "sfo-0123abcd", () => ch.nonce);
    expect((await s.call("POST", "/projects/import", token, { nonce: ch.nonce, repo: null })).status).toBe(200);
    expect(((await (await s.call("GET", "/projects", token)).json()) as { sprite: string }[]).map((p) => p.sprite)).toEqual(["sfo-0123abcd"]);
  });

  it("refuses a Sprite that does not hold the challenge: naming one proves nothing", async () => {
    const s = server();
    const token = await s.signIn("me");
    const ch = (await (await s.call("POST", "/projects/import/challenge", token, { id: "moon-abc123", sprite: "sfo-0123abcd" })).json()) as { nonce: string };
    holding(s, "sfo-0123abcd", () => "something else");
    expect((await s.call("POST", "/projects/import", token, { nonce: ch.nonce })).status).toBe(403);
    expect(await (await s.call("GET", "/projects", token)).json()).toEqual([]);
  });

  it("refuses another person's challenge, and a Sprite already claimed", async () => {
    const s = server();
    const mine = await s.signIn("me");
    const yours = await s.signIn("you");
    const ch = (await (await s.call("POST", "/projects/import/challenge", mine, { id: "moon-abc123", sprite: "sfo-0123abcd" })).json()) as { nonce: string };
    holding(s, "sfo-0123abcd", () => ch.nonce);
    expect((await s.call("POST", "/projects/import", yours, { nonce: ch.nonce })).status).toBe(400);

    await withProject(s);
    const created = s.fake.created[0];
    expect((await s.call("POST", "/projects/import/challenge", yours, { id: "other-abc123", sprite: created })).status).toBe(409);
  });

  it("refuses names that are not sfo's", async () => {
    const s = server();
    const token = await s.signIn("me");
    expect((await s.call("POST", "/projects/import/challenge", token, { id: "../etc", sprite: "sfo-0123abcd" })).status).toBe(400);
    expect((await s.call("POST", "/projects/import/challenge", token, { id: "moon-abc123", sprite: "sfo-sprite" })).status).toBe(400);
  });
});
