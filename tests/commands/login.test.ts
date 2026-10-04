import { describe, it, expect } from "vitest";
import { githubDeviceFlow } from "../../src/commands/login.js";

/** GitHub's device endpoints, answering `polls` in order. */
function github(polls: Record<string, unknown>[]) {
  const asked: string[] = [];
  const fetch = (async (url: string) => {
    asked.push(url);
    const body = url.endsWith("/login/device/code")
      ? { device_code: "dc", user_code: "WDJB-MJHT", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 }
      : polls.shift();
    return new Response(JSON.stringify(body));
  }) as typeof globalThis.fetch;
  return { fetch, asked };
}

describe("GitHub's device flow", () => {
  it("waits as long as GitHub says, slows down when asked, and returns the tokens", async () => {
    const gh = github([{ error: "authorization_pending" }, { error: "slow_down", interval: 10 }, { access_token: "ghu_x", refresh_token: "ghr_x", expires_in: 28800 }]);
    const waited: number[] = [];
    const said: string[] = [];
    const tokens = await githubDeviceFlow("Iv-test", { fetch: gh.fetch, log: (m) => said.push(m), open: () => {}, wait: async (ms) => void waited.push(ms) });

    expect(said.join("\n")).toContain("WDJB-MJHT");
    expect(waited).toEqual([5000, 5000, 10000]);
    expect(tokens).toMatchObject({ accessToken: "ghu_x", refreshToken: "ghr_x" });
  });

  it("stops when the person declines", async () => {
    const gh = github([{ error: "access_denied" }]);
    await expect(githubDeviceFlow("Iv-test", { fetch: gh.fetch, log: () => {}, open: () => {}, wait: async () => {} })).rejects.toThrow(/declined/);
  });
});
