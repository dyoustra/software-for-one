import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { openDb } from "../../src/server/db.js";
import { createApp } from "../../src/server/app.js";
import { Vault } from "../../src/server/credentials.js";
import type { GitHubDevice } from "../../src/server/github-signin.js";
import { noSprites } from "./fakes.js";

type Poll = Awaited<ReturnType<GitHubDevice["poll"]>>;

/**
 * GitHub, scripted: each poll answers with the next entry (the last one
 * repeats), and every token belongs to `githubId`.
 */
function fakeGitHub(answers: Poll[], githubId = "4242") {
  const polls: string[] = [];
  const github: GitHubDevice = {
    start: async () => ({ deviceCode: "dc-1", userCode: "ABCD-1234", verificationUri: "https://github.com/login/device", intervalS: 0, expiresInS: 900 }),
    poll: async (deviceCode) => {
      polls.push(deviceCode);
      return answers[Math.min(polls.length - 1, answers.length - 1)];
    },
    userId: async (token) => {
      expect(token).toBe("gho_test");
      return githubId;
    },
  };
  return { github, polls };
}

function server(answers: Poll[], opts: { githubId?: string; allowedGithub?: string[] } = {}) {
  const said: string[] = [];
  const db = openDb(":memory:");
  const { github, polls } = fakeGitHub(answers, opts.githubId);
  const oauth = { clientId: "x", authorizeUrl: () => "", whoami: async () => "x", exchange: async () => ({ accessToken: "", refreshToken: null, expiresAt: null }) };
  const allowedApple = new Set(["me", "you"]);
  const allowedGithub = new Set(opts.allowedGithub ?? ["4242"]);
  const app = createApp({
    db, version: "t", verifyApple: async (t) => ({ sub: t }), allowed: allowedApple, publicUrl: "https://cp.test", holdMs: 50,
    log: (m) => said.push(m), vault: new Vault(db, randomBytes(32).toString("base64")), github: oauth, githubRedirects: [], sprites: noSprites,
    githubDevice: github, allowedGithub,
  });
  const call = (method: string, path: string, body?: unknown, token?: string, origin?: string) =>
    app.request(path, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(origin ? { origin } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const start = async () => (await (await call("POST", "/auth/github/start")).json()) as { flow: string; userCode: string; verificationUri: string };
  const apple = async (idToken: string) => ((await (await call("POST", "/auth/apple", { idToken })).json()) as { token: string }).token;
  return { db, said, polls, call, start, apple, allowedApple, allowedGithub };
}

const approved: Poll = { token: "gho_test" };
const pending: Poll = { pending: true };

describe("sign in with GitHub", () => {
  it("shows GitHub's code, then signs in an allowed GitHub account once it is approved", async () => {
    const s = server([pending, approved]);
    const started = await s.start();
    expect(started).toEqual({ flow: expect.any(String), userCode: "ABCD-1234", verificationUri: "https://github.com/login/device" });

    const res = await s.call("POST", "/auth/github/wait", { flow: started.flow, deviceName: "chrome" });
    expect(res.status).toBe(200);
    const { token } = (await res.json()) as { token: string };
    expect(s.polls.length).toBe(2);
    expect(await (await s.call("GET", "/identities", undefined, token)).json()).toEqual([{ provider: "github", createdAt: expect.any(String) }]);
  });

  it("finds the same account the next time", async () => {
    const s = server([approved]);
    const first = (await (await s.call("POST", "/auth/github/wait", { flow: (await s.start()).flow })).json()) as { token: string };
    const second = (await (await s.call("POST", "/auth/github/wait", { flow: (await s.start()).flow })).json()) as { token: string };
    expect(first.token).not.toBe(second.token);
    expect(s.db.prepare("SELECT count(*) AS n FROM users").get()).toEqual({ n: 1 });
  });

  it("refuses a GitHub account not on the allowlist, and says how to allow it by id only", async () => {
    const s = server([approved], { githubId: "999", allowedGithub: ["4242"] });
    const res = await s.call("POST", "/auth/github/wait", { flow: (await s.start()).flow });
    expect(res.status).toBe(403);
    expect(s.db.prepare("SELECT count(*) AS n FROM users").get()).toEqual({ n: 0 });
    expect(s.said).toEqual(["sign-in refused for GitHub id 999 — to allow it: fly secrets set SFO_ALLOWED_GITHUB_IDS=999"]);
  });

  it("asks the client to wait again while the person has not approved yet", async () => {
    const s = server([pending]);
    const { flow } = await s.start();
    const res = await s.call("POST", "/auth/github/wait", { flow });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "pending" });
  });

  it("ends the flow when the person declines on GitHub", async () => {
    const s = server([{ error: "declined on GitHub" }]);
    const { flow } = await s.start();
    const res = await s.call("POST", "/auth/github/wait", { flow });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "declined on GitHub" });
    expect((await s.call("POST", "/auth/github/wait", { flow })).status).toBe(410);
  });

  it("knows no flow it did not start", async () => {
    const s = server([approved]);
    await s.start();
    expect((await s.call("POST", "/auth/github/wait", { flow: "made-up" })).status).toBe(410);
    expect(s.polls).toEqual([]);
  });

  it("cannot be used twice: an approved flow is spent", async () => {
    const s = server([approved]);
    const { flow } = await s.start();
    expect((await s.call("POST", "/auth/github/wait", { flow })).status).toBe(200);
    expect((await s.call("POST", "/auth/github/wait", { flow })).status).toBe(410);
  });
});

describe("adding GitHub to an account", () => {
  it("links it to the signed-in account, which it then signs in to, allowlisted or not", async () => {
    const s = server([approved], { allowedGithub: [] });
    const device = await s.apple("me");
    const linked = await s.call("POST", "/auth/github/wait", { flow: (await s.start()).flow, link: true }, device);
    expect(await linked.json()).toEqual({ ok: true, linked: "github" });
    const providers = ((await (await s.call("GET", "/identities", undefined, device)).json()) as { provider: string }[]).map((i) => i.provider);
    expect(providers.sort()).toEqual(["apple", "github"]);

    const signedIn = await s.call("POST", "/auth/github/wait", { flow: (await s.start()).flow });
    expect(signedIn.status).toBe(200);
    expect(s.db.prepare("SELECT count(*) AS n FROM users").get()).toEqual({ n: 1 });
  });

  it("locks the account out, by every method, once none of its methods is allowlisted", async () => {
    const s = server([approved], { allowedGithub: [] });
    await s.call("POST", "/auth/github/wait", { flow: (await s.start()).flow, link: true }, await s.apple("me"));

    s.allowedApple.delete("me");
    expect((await s.call("POST", "/auth/apple", { idToken: "me" })).status).toBe(403);
    expect((await s.call("POST", "/auth/github/wait", { flow: (await s.start()).flow })).status).toBe(403);

    s.allowedGithub.add("4242");
    expect((await s.call("POST", "/auth/apple", { idToken: "me" })).status).toBe(200);
  });

  it("will not take a GitHub account that already signs in to someone else", async () => {
    const s = server([approved]);
    await s.call("POST", "/auth/github/wait", { flow: (await s.start()).flow });
    const other = await s.apple("you");
    const res = await s.call("POST", "/auth/github/wait", { flow: (await s.start()).flow, link: true }, other);
    expect(res.status).toBe(409);
    const providers = ((await (await s.call("GET", "/identities", undefined, other)).json()) as { provider: string }[]).map((i) => i.provider);
    expect(providers).toEqual(["apple"]);
  });

  it("needs someone signed in to link to", async () => {
    const s = server([approved]);
    const res = await s.call("POST", "/auth/github/wait", { flow: (await s.start()).flow, link: true }, "sfod_not-a-token");
    expect(res.status).toBe(401);
    expect(s.db.prepare("SELECT count(*) AS n FROM identities").get()).toEqual({ n: 0 });
  });
});

describe("calls from the web build", () => {
  it("are allowed from the web build's origin only", async () => {
    const s = server([approved]);
    const ours = await s.call("OPTIONS", "/auth/github/start", undefined, undefined, "http://localhost:8081");
    expect(ours.headers.get("access-control-allow-origin")).toBe("http://localhost:8081");
    const theirs = await s.call("OPTIONS", "/auth/github/start", undefined, undefined, "https://evil.example");
    expect(theirs.headers.get("access-control-allow-origin")).toBeNull();
  });
});
