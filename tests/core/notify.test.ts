import { describe, it, expect } from "vitest";
import { notificationCommands, spawningApp } from "../../src/core/notify.js";

describe("notifications", () => {
  it("bring back whichever app started sfo, read from the environment", () => {
    const [first] = notificationCommands("sfo: T", "done", { __CFBundleIdentifier: "dev.warp.Warp-Stable" });
    expect(first.slice(-2)).toEqual(["-activate", "dev.warp.Warp-Stable"]);
    expect(notificationCommands("t", "m", { __CFBundleIdentifier: "com.googlecode.iterm2" })[0]).toContain("com.googlecode.iterm2");
  });

  it("activate nothing when it is unknown, or not a plain bundle id", () => {
    expect(notificationCommands("t", "m", {})[0]).not.toContain("-activate");
    expect(spawningApp({ __CFBundleIdentifier: "$(touch x)" })).toBeNull();
  });

  it("fall back to AppleScript, with the text passed as arguments", () => {
    const fallback = notificationCommands('a "quoted" title', "m", {})[1];
    expect(fallback[0]).toBe("osascript");
    expect(fallback.slice(-2)).toEqual(['a "quoted" title', "m"]);
  });
});
