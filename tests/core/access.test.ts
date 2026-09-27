import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readProfile,
  writeProfile,
  readAccess,
  writeAccess,
  parseAccessFlag,
  parseKeyRef,
  resolveAccess,
  resolveProjectAccess,
  childEnv,
  billingFor,
  profilePath,
  type Access,
  type KeyReader,
  type Profile,
} from "../../src/core/access.js";

let home: string;
let env: Record<string, string>;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "sfo-access-"));
  env = { SFO_HOME: home };
});

const profile = (over: Partial<Profile> = {}): Profile =>
  writeProfile(
    {
      modelAccess: ["claude_subscription", "anthropic_api_key"],
      apiKey: { source: "keychain", service: "anthropic-api-key" },
      sfoPrefers: "claude_subscription",
      updatedAt: new Date().toISOString(),
      ...over,
    },
    env,
  );

const keyring: KeyReader = (ref) =>
  ref.source === "keychain" && ref.service === "anthropic-api-key" ? "sk-from-keychain" : null;

describe("profile", () => {
  it("is absent until written, and round-trips with defaults filled", () => {
    expect(readProfile(env)).toBeNull();
    profile();
    const read = readProfile(env);
    expect(read?.fallbackToApiKey).toBe(false);
    expect(read?.apiKey).toEqual({ source: "keychain", service: "anthropic-api-key" });
  });

  it("names the file when it is not JSON", () => {
    fs.writeFileSync(profilePath(env), "{nope");
    expect(() => readProfile(env)).toThrow(/profile\.json is not valid JSON/);
  });
});

describe("project snapshot", () => {
  it("round-trips and holds no key reference", () => {
    fs.mkdirSync(path.join(home, "p", ".sfo"), { recursive: true });
    writeAccess("p", { modelAccess: ["anthropic_api_key"], sfoPrefers: "anthropic_api_key" }, env);
    expect(readAccess("p", env)).toEqual({
      modelAccess: ["anthropic_api_key"],
      sfoPrefers: "anthropic_api_key",
    });
    expect(fs.readFileSync(path.join(home, "p", ".sfo", "ACCESS.json"), "utf8")).not.toContain("keychain");
  });
});

describe("parsing flags", () => {
  it("prefers the subscription when it is listed", () => {
    expect(parseAccessFlag("anthropic_api_key, claude_subscription").sfoPrefers).toBe(
      "claude_subscription",
    );
    expect(parseAccessFlag("anthropic_api_key").sfoPrefers).toBe("anthropic_api_key");
  });

  it("rejects unknown methods", () => {
    expect(() => parseAccessFlag("claude_max")).toThrow(/comma-separated list/);
  });

  it("parses key references", () => {
    expect(parseKeyRef("env:MY_KEY")).toEqual({ source: "env", var: "MY_KEY" });
    expect(parseKeyRef("keychain:svc")).toEqual({ source: "keychain", service: "svc" });
    expect(() => parseKeyRef("sk-ant-abc")).toThrow(/env:<VAR> or keychain:<service>/);
  });
});

describe("resolveAccess", () => {
  const both: Access = {
    modelAccess: ["claude_subscription", "anthropic_api_key"],
    sfoPrefers: "claude_subscription",
  };

  it("inherits the shell when there is no snapshot and no override", () => {
    expect(resolveAccess(null, null, { env })).toEqual({ method: "inherit" });
  });

  it("uses the preference when it is available", () => {
    expect(resolveAccess(both, profile(), { env, readKeyWith: keyring })).toEqual({
      method: "claude_subscription",
    });
  });

  it("reads the key from the profile's reference when the key is chosen", () => {
    const p = profile({ sfoPrefers: "anthropic_api_key" });
    expect(
      resolveAccess({ ...both, sfoPrefers: "anthropic_api_key" }, p, { env, readKeyWith: keyring }),
    ).toEqual({ method: "anthropic_api_key", apiKey: "sk-from-keychain" });
  });

  it("falls back to the first usable method when the preference is not listed", () => {
    const keyOnly: Access = { modelAccess: ["ollama", "anthropic_api_key"], sfoPrefers: "claude_subscription" };
    expect(resolveAccess(keyOnly, profile(), { env, readKeyWith: keyring }).method).toBe(
      "anthropic_api_key",
    );
  });

  it("refuses a project that lists nothing sfo can run on", () => {
    expect(() =>
      resolveAccess({ modelAccess: ["ollama"], sfoPrefers: "claude_subscription" }, null, { env }),
    ).toThrow(/lists neither/);
  });

  it("uses the key on --use-api-key, even with no snapshot", () => {
    expect(
      resolveAccess(null, profile(), { env, readKeyWith: keyring, useApiKey: true }),
    ).toEqual({ method: "anthropic_api_key", apiKey: "sk-from-keychain" });
  });

  it("names the reference when the key cannot be found", () => {
    expect(() =>
      resolveAccess(null, profile({ apiKey: { source: "env", var: "NOPE" } }), {
        env,
        useApiKey: true,
      }),
    ).toThrow(/no API key found at env:NOPE/);
  });

  it("defaults the reference to ANTHROPIC_API_KEY with no profile", () => {
    expect(
      resolveAccess(null, null, { env: { ...env, ANTHROPIC_API_KEY: "sk-env" }, useApiKey: true }),
    ).toEqual({ method: "anthropic_api_key", apiKey: "sk-env" });
  });
});

describe("resolveProjectAccess", () => {
  it("prefers the project's snapshot to the profile", () => {
    profile();
    fs.mkdirSync(path.join(home, "p", ".sfo"), { recursive: true });
    writeAccess("p", { modelAccess: ["anthropic_api_key"], sfoPrefers: "anthropic_api_key" }, env);
    expect(resolveProjectAccess("p", { env, readKeyWith: keyring }).method).toBe("anthropic_api_key");
  });

  it("uses the profile for a project made before snapshots", () => {
    profile();
    expect(resolveProjectAccess("old", { env, readKeyWith: keyring }).method).toBe(
      "claude_subscription",
    );
  });
});

describe("childEnv", () => {
  const shell = { PATH: "/bin", ANTHROPIC_API_KEY: "sk-shell", ANTHROPIC_AUTH_TOKEN: "tok" };

  it("strips every credential on the subscription, so claude uses its login", () => {
    const out = childEnv(shell, { method: "claude_subscription" });
    expect(out.ANTHROPIC_API_KEY).toBeUndefined();
    expect(out.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(out.PATH).toBe("/bin");
  });

  it("sets the resolved key, replacing the shell's", () => {
    const out = childEnv(shell, { method: "anthropic_api_key", apiKey: "sk-chosen" });
    expect(out.ANTHROPIC_API_KEY).toBe("sk-chosen");
    expect(out.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it("passes the shell through untouched when inheriting", () => {
    expect(childEnv(shell, { method: "inherit" })).toEqual(shell);
  });
});

describe("billingFor", () => {
  it("labels the chosen route, and guesses only from a key in the shell", () => {
    expect(billingFor({ method: "anthropic_api_key", apiKey: "k" }, {})).toBe("api");
    expect(billingFor({ method: "claude_subscription" }, { ANTHROPIC_API_KEY: "k" })).toBe("plan");
    expect(billingFor({ method: "inherit" }, { ANTHROPIC_API_KEY: "k" })).toBe("api");
    expect(billingFor({ method: "inherit" }, {})).toBeUndefined();
  });
});
