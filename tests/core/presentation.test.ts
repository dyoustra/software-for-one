import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureRenders, cleanCapture, readRenders, type Run } from "../../src/core/presentation.js";

let env: Record<string, string>;
let sfo: string;

beforeEach(() => {
  env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-present-")) };
  sfo = path.join(env.SFO_HOME, "p", ".sfo");
  fs.mkdirSync(sfo, { recursive: true });
});

const present = (o: object) => fs.writeFileSync(path.join(sfo, "PRESENTATION.json"), JSON.stringify(o));

function fakeRun() {
  const calls: string[][] = [];
  const run: Run = (command, args) => {
    calls.push([command, ...args]);
    if (command === "script") return { status: 0, stdout: Buffer.from("^D\b\b\x1b[38;2;191;87;0mTOWER\x1b[0m\r\nline two\r\n"), stderr: "" };
    // The screenshot renderer: write the two files it was asked for.
    fs.writeFileSync(args.at(-2) ?? "", "png");
    fs.writeFileSync(args.at(-1) ?? "", "png");
    return { status: 0, stdout: Buffer.alloc(0), stderr: "" };
  };
  return { run, calls };
}

describe("cleanCapture", () => {
  it("drops script's echoed ^D and backspaces, and normalises line ends", () => {
    expect(cleanCapture(Buffer.from("^D\b\bhello\r\nworld\r\n"))).toBe("hello\nworld\n");
    expect(cleanCapture(Buffer.from("plain\r\n"))).toBe("plain\n");
  });
});

describe("captureRenders", () => {
  it("does nothing for a tool with nothing to see, or no presentation at all", () => {
    const { run, calls } = fakeRun();
    expect(captureRenders("p", "cli-python", env, run)).toEqual([]);
    present({ kind: "none", why: "writes a file", invocations: [] });
    expect(captureRenders("p", "cli-python", env, run)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("captures text output on a real pseudo-terminal, through the project's own environment", () => {
    present({ kind: "text", why: "a report", invocations: [["tool", "--now", "2026-09-29"]] });
    const { run, calls } = fakeRun();
    const [r] = captureRenders("p", "cli-python", env, run);

    expect(calls).toEqual([["script", "-q", "/dev/null", "uv", "run", "tool", "--now", "2026-09-29"]]);
    expect(r).toEqual({ invocation: ["tool", "--now", "2026-09-29"], text: "renders/1.txt" });
    expect(fs.readFileSync(path.join(sfo, "renders", "1.txt"), "utf8")).toBe("\x1b[38;2;191;87;0mTOWER\x1b[0m\nline two\n");
    expect(readRenders("p", env)).toHaveLength(1);
  });

  it("draws a visual tool on a light and a dark background", () => {
    present({ kind: "visual", why: "a drawing", invocations: [["ut-tower"]] });
    const { run, calls } = fakeRun();
    const [r] = captureRenders("p", "cli-python", env, run);

    expect(calls[1].slice(0, 6)).toEqual(["uv", "run", "--no-project", "--with", "pillow", "python"]);
    expect(r).toMatchObject({ light: "renders/1-light.png", dark: "renders/1-dark.png" });
  });

  it("records a run that exited badly without failing the rest", () => {
    present({ kind: "text", why: "r", invocations: [["tool"]] });
    const run: Run = () => ({ status: 2, stdout: Buffer.from("usage: tool\n"), stderr: "boom" });
    expect(captureRenders("p", "cli-python", env, run)[0]).toMatchObject({ text: "renders/1.txt", error: "exited 2: boom" });
  });
});

describe("drawDrafts", () => {
  it("draws each draft spec wrote, on a light and a dark background", async () => {
    const { drawDrafts, draftImages } = await import("../../src/core/presentation.js");
    fs.mkdirSync(path.join(sfo, "drafts"), { recursive: true });
    fs.writeFileSync(path.join(sfo, "drafts", "A.txt"), "draft a\n");
    fs.writeFileSync(path.join(sfo, "drafts", "B.txt"), "draft b\n");
    fs.writeFileSync(path.join(sfo, "drafts", "notes.md"), "not a draft\n");
    const { run, calls } = fakeRun();

    expect(drawDrafts("p", env, run)).toEqual([
      { draft: "A", light: "drafts/A-light.png", dark: "drafts/A-dark.png" },
      { draft: "B", light: "drafts/B-light.png", dark: "drafts/B-dark.png" },
    ]);
    expect(calls).toHaveLength(2);
    expect(draftImages("p", env).map((p) => path.basename(p))).toEqual(["A-dark.png", "A-light.png", "B-dark.png", "B-light.png"]);
  });

  it("draws nothing when spec judged the look incidental", async () => {
    const { drawDrafts } = await import("../../src/core/presentation.js");
    expect(drawDrafts("p", env, fakeRun().run)).toEqual([]);
  });
});
