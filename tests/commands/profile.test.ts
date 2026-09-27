import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupProfile, formatProfile, setProfile } from "../../src/commands/profile.js";
import { readProfile, type KeyReader } from "../../src/core/access.js";

let env: Record<string, string>;

beforeEach(() => {
  env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-profile-")) };
});

const answers = (...replies: string[]) => {
  const queue = [...replies];
  return async () => queue.shift() ?? "";
};
const quiet = () => {};
const keychainHas: KeyReader = (ref) =>
  ref.source === "keychain" && ref.service === "anthropic-api-key" ? "sk-secret-value" : null;
const nothing: KeyReader = () => null;

describe("setupProfile", () => {
  it("saves a subscription-only profile without asking about a key", async () => {
    const p = await setupProfile(answers("1"), quiet, env, nothing);
    expect(p.modelAccess).toEqual(["claude_subscription"]);
    expect(p.apiKey).toBeNull();
    expect(readProfile(env)?.sfoPrefers).toBe("claude_subscription");
  });

  it("defaults the key to the Keychain and prefers the subscription for sfo's runs", async () => {
    const p = await setupProfile(answers("1,2", ""), quiet, env, keychainHas);
    expect(p.apiKey).toEqual({ source: "keychain", service: "anthropic-api-key" });
    expect(p.sfoPrefers).toBe("claude_subscription");
  });

  it("prefers the key when it is all there is", async () => {
    const p = await setupProfile(answers("2", "env:MY_KEY"), quiet, { ...env, MY_KEY: "sk" });
    expect(p.sfoPrefers).toBe("anthropic_api_key");
    expect(p.apiKey).toEqual({ source: "env", var: "MY_KEY" });
  });

  it("saves nothing when the key is not where it was said to be", async () => {
    await expect(setupProfile(answers("2", ""), quiet, env, nothing)).rejects.toThrow(
      /nothing found at keychain:anthropic-api-key/,
    );
    expect(readProfile(env)).toBeNull();
  });

  it("rejects an answer that is not a listed choice", async () => {
    await expect(setupProfile(answers("max"), quiet, env, nothing)).rejects.toThrow(/answer with 1 and\/or 2/);
  });
});

describe("formatProfile", () => {
  it("says where the key lives and whether it is there, never what it is", async () => {
    const p = await setupProfile(answers("1,2", ""), quiet, env, keychainHas);
    const out = formatProfile(p, env, keychainHas);
    expect(out).toContain("keychain:anthropic-api-key (found)");
    expect(out).not.toContain("sk-secret-value");
    expect(formatProfile(p, env, nothing)).toContain("NOT FOUND");
  });

  it("points at setup when there is no profile", () => {
    expect(formatProfile(null, env)).toMatch(/sfo profile setup/);
  });
});

describe("setProfile", () => {
  beforeEach(async () => {
    await setupProfile(answers("1,2", ""), quiet, env, keychainHas);
  });

  it("changes the preference only to a method in the access list", () => {
    expect(setProfile("prefers", "anthropic_api_key", env).sfoPrefers).toBe("anthropic_api_key");
    setProfile("access", "claude_subscription", env);
    expect(() => setProfile("prefers", "anthropic_api_key", env)).toThrow(/not in your access list/);
  });

  it("moves the preference when the access list drops it", () => {
    setProfile("prefers", "anthropic_api_key", env);
    expect(setProfile("access", "claude_subscription", env).sfoPrefers).toBe("claude_subscription");
  });

  it("refuses a key reference that finds nothing", () => {
    expect(() => setProfile("key", "env:NOPE", env, nothing)).toThrow(/nothing found at env:NOPE/);
  });

  it("toggles the fallback", () => {
    expect(setProfile("fallback", "on", env).fallbackToApiKey).toBe(true);
    expect(() => setProfile("fallback", "yes", env)).toThrow(/on or off/);
  });

  it("names the settings on an unknown one", () => {
    expect(() => setProfile("model", "x", env)).toThrow(/access, key, prefers, fallback/);
  });
});
