import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { controlUrl, DEFAULT_CONTROL_URL } from "../../src/commands/login.js";

function home(saved?: object) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sfo-control-"));
  if (saved) fs.writeFileSync(path.join(dir, "control.json"), JSON.stringify(saved));
  return { env: { SFO_HOME: dir }, read: () => JSON.parse(fs.readFileSync(path.join(dir, "control.json"), "utf8")) };
}

describe("the CLI's control plane address", () => {
  it("is the API's own address by default", () => {
    expect(DEFAULT_CONTROL_URL).toBe("https://api.sfo.dannyyoustra.com");
    expect(controlUrl(home().env)).toBe(DEFAULT_CONTROL_URL);
  });

  it("follows the move off sfo.dannyyoustra.com, rewriting what login saved and keeping the rest", () => {
    const h = home({ url: "https://sfo.dannyyoustra.com", githubFingerprint: "abc" });
    expect(controlUrl(h.env)).toBe("https://api.sfo.dannyyoustra.com");
    expect(h.read()).toEqual({ url: "https://api.sfo.dannyyoustra.com", githubFingerprint: "abc" });
  });

  it("leaves any other saved address, and an explicit SFO_CONTROL_URL, alone", () => {
    const h = home({ url: "https://sfo-control.fly.dev" });
    expect(controlUrl(h.env)).toBe("https://sfo-control.fly.dev");
    expect(h.read()).toEqual({ url: "https://sfo-control.fly.dev" });
    expect(controlUrl({ ...home({ url: "https://sfo.dannyyoustra.com" }).env, SFO_CONTROL_URL: "http://localhost:8080" })).toBe("http://localhost:8080");
  });
});
