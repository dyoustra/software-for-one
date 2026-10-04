import { describe, it, expect } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { openDb } from "../../src/server/db.js";
import { createApp } from "../../src/server/app.js";
import { Vault, githubToken, type GitHubOAuth, type GitHubTokens } from "../../src/server/credentials.js";

const CLAUDE = "sk-ant-oat01-secret-value";
const APP_RETURN = "sfo://github";

function server() {
  const db = openDb(":memory:");
  const vault = new Vault(db, randomBytes(32).toString("base64"));
  const exchanged: unknown[] = [];
  const github: GitHubOAuth = {
    clientId: "Iv-test",
    authorizeUrl: (state, redirect, challenge) => `https://github.test/authorize?state=${state}&redirect_uri=${redirect}&code_challenge=${challenge}`,
    exchange: async (grant) => {
      exchanged.push(grant);
      return { accessToken: "code" in grant ? "ghu_first" : "ghu_fresh", refreshToken: "ghr_x", expiresAt: new Date(Date.now() + 8 * 3600_000).toISOString() };
    },
    whoami: async (t) => {
      if (t !== "ghu_real") throw new Error("401");
      return "dyoustra";
    },
  };
  const app = createApp({ db, version: "t", verifyApple: async (t) => ({ sub: t }), allowed: new Set(["me", "you"]), publicUrl: "https://cp.test", holdMs: 50, vault, github, githubRedirects: [APP_RETURN] });
  const call = (method: string, path: string, token?: string, body?: unknown) =>
    app.request(path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const signIn = async (who: string) => ((await (await call("POST", "/auth/apple", undefined, { idToken: who })).json()) as { token: string }).token;
  return { app, db, vault, call, signIn, exchanged };
}

describe("credentials", () => {
  it("are stored encrypted: the database holds no readable copy", async () => {
    const s = server();
    const token = await s.signIn("me");
    expect((await s.call("PUT", "/credentials/claude", token, { value: CLAUDE })).status).toBe(200);

    const raw = s.db.prepare("SELECT ciphertext FROM credentials").get() as { ciphertext: Uint8Array };
    expect(Buffer.from(raw.ciphertext).toString("utf8")).not.toContain("secret-value");
    const userId = (s.db.prepare("SELECT id FROM users").get() as { id: string }).id;
    expect(s.vault.get(userId, "claude_token")).toBe(CLAUDE);
  });

  it("are only ever listed by kind, never returned", async () => {
    const s = server();
    const token = await s.signIn("me");
    await s.call("PUT", "/credentials/claude", token, { value: CLAUDE });
    const res = await s.call("GET", "/credentials", token);
    expect(await res.text()).toBe(JSON.stringify({ have: ["claude_token"] }));
  });

  it("refuse something that is not the credential named", async () => {
    const s = server();
    const token = await s.signIn("me");
    expect((await s.call("PUT", "/credentials/claude", token, { value: "sk-ant-api03-key" })).status).toBe(400);
    expect((await s.call("PUT", "/credentials/api-key", token, { value: CLAUDE })).status).toBe(400);
  });

  it("are one person's own", async () => {
    const s = server();
    const mine = await s.signIn("me");
    const yours = await s.signIn("you");
    await s.call("PUT", "/credentials/claude", mine, { value: CLAUDE });
    expect(await (await s.call("GET", "/credentials", yours)).json()).toEqual({ have: [] });
  });

  it("cannot be opened with another key", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO users (id, apple_sub, created_at) VALUES ('u', 'me', 't')").run();
    new Vault(db, randomBytes(32).toString("base64")).put("u", "claude_token", CLAUDE);
    expect(() => new Vault(db, randomBytes(32).toString("base64")).get("u", "claude_token")).toThrow();
  });
});

describe("connecting GitHub from the app", () => {
  /** The app starts a connection; GitHub returns `state` to it, and it finishes. */
  async function start(s: ReturnType<typeof server>, who: string) {
    const token = await s.signIn(who);
    const res = await s.call("POST", "/github/connect", token, { redirectUri: APP_RETURN });
    const state = new URL(((await res.json()) as { url: string }).url).searchParams.get("state") ?? "";
    return { token, state };
  }
  const finish = (s: ReturnType<typeof server>, token: string, state: string) =>
    s.call("POST", "/github/complete", token, { code: "abc", state });

  it("stores the account's tokens when the person who started it finishes it", async () => {
    const s = server();
    const { token, state } = await start(s, "me");
    expect((await finish(s, token, state)).status).toBe(200);
    expect(await (await s.call("GET", "/credentials", token)).json()).toEqual({ have: ["github_installation"] });
  });

  it("refuses a connection someone else started, so your GitHub cannot be linked to their account", async () => {
    const s = server();
    const theirs = await start(s, "you");
    const mine = await s.signIn("me");
    expect((await finish(s, mine, theirs.state)).status).toBe(403);
    expect(s.exchanged).toEqual([]);
  });

  it("redeems the code with the PKCE verifier behind the challenge GitHub was given, and its own return address", async () => {
    const s = server();
    const token = await s.signIn("me");
    const url = new URL(((await (await s.call("POST", "/github/connect", token, { redirectUri: APP_RETURN })).json()) as { url: string }).url);
    await s.call("POST", "/github/complete", token, { code: "abc", state: url.searchParams.get("state"), redirectUri: "https://evil.test" });

    const [grant] = s.exchanged as { codeVerifier: string; redirectUri: string }[];
    expect(createHash("sha256").update(grant.codeVerifier).digest("base64url")).toBe(url.searchParams.get("code_challenge"));
    expect(grant.redirectUri).toBe(APP_RETURN);
  });

  it("works once: a replay is refused", async () => {
    const s = server();
    const { token, state } = await start(s, "me");
    await finish(s, token, state);
    expect((await finish(s, token, state)).status).toBe(400);
    expect(s.exchanged).toHaveLength(1);
  });

  it("only sends GitHub's answer back to the app's own addresses", async () => {
    const s = server();
    const token = await s.signIn("me");
    expect((await s.call("POST", "/github/connect", token, { redirectUri: "https://evil.test/steal" })).status).toBe(400);
  });

  it("refuses a connection it never started", async () => {
    const s = server();
    const token = await s.signIn("me");
    expect((await finish(s, token, "made-up")).status).toBe(400);
  });
});

describe("connecting GitHub from the CLI", () => {
  it("keeps device-flow tokens only once GitHub confirms them", async () => {
    const s = server();
    const token = await s.signIn("me");
    expect((await s.call("PUT", "/credentials/github", token, { accessToken: "ghu_fake" })).status).toBe(400);
    const ok = await s.call("PUT", "/credentials/github", token, { accessToken: "ghu_real", refreshToken: "ghr_1", expiresAt: null });
    expect(await ok.json()).toEqual({ ok: true, login: "dyoustra" });
  });

  it("tells the CLI which GitHub App to sign in to", async () => {
    const s = server();
    expect(await (await s.call("GET", "/github/app")).json()).toEqual({ clientId: "Iv-test" });
  });
  it("refreshes a token about to expire before handing it out", async () => {
    const s = server();
    s.db.prepare("INSERT INTO users (id, apple_sub, created_at) VALUES ('u', 'me', 't')").run();
    const expiring: GitHubTokens = { accessToken: "ghu_old", refreshToken: "ghr_x", expiresAt: new Date(Date.now() + 60_000).toISOString() };
    s.vault.put("u", "github_installation", JSON.stringify(expiring));
    const gh: GitHubOAuth = { clientId: "x", authorizeUrl: () => "", whoami: async () => "x", exchange: async () => ({ accessToken: "ghu_fresh", refreshToken: "ghr_y", expiresAt: null }) };

    expect(await githubToken(s.vault, gh, "u")).toBe("ghu_fresh");
    expect(JSON.parse(s.vault.get("u", "github_installation") ?? "{}").accessToken).toBe("ghu_fresh");
  });
});
