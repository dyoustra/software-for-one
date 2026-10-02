import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readContractFile, globRegex, filesFor, stepCovers, gateSteps, CONTRACTS_FILE } from "../../src/core/contracts.js";
import { runVerify, gateFor, sliceTestFiles, verifiabilityProblem } from "../../src/core/verify.js";
import { lockTests, verifyTestLock } from "../../src/core/testlock.js";
import { installTool, type Exec } from "../../src/core/install.js";
import { captureRenders, type Run } from "../../src/core/presentation.js";

let env: Record<string, string>;
let dir: string;

const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const contract = (c: object) => write(`.sfo/${CONTRACTS_FILE}`, JSON.stringify(c));
const node = (code: string) => [process.execPath, "-e", code];

beforeEach(() => {
  env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-contract-")) };
  dir = path.join(env.SFO_HOME, "p");
  fs.mkdirSync(path.join(dir, ".sfo"), { recursive: true });
});

describe("the contract file", () => {
  it("is absent for a project from before contracts", () => {
    expect(readContractFile("p", env)).toBeNull();
  });

  it("must scope at least one gate step to a slice, or no slice would be tested", () => {
    contract({ gate: [{ name: "lint", run: ["npm", "run", "lint"] }] });
    expect(() => readContractFile("p", env)).toThrow(/no gate step is scoped/);
  });

  it("names the file when it does not parse", () => {
    write(`.sfo/${CONTRACTS_FILE}`, "{gate:");
    expect(() => readContractFile("p", env)).toThrow(/CONTRACTS\.json is not valid JSON/);
  });
});

describe("{slice} in a files glob", () => {
  it("matches the slice id as test files loosely spell it, and only that slice", () => {
    const r = globRegex("tests/**/*{slice}*", "S-01");
    for (const ok of ["tests/test_s01_naming.py", "tests/s-01.test.ts", "tests/deep/TEST_S_01.py"]) expect(r.test(ok), ok).toBe(true);
    for (const no of ["tests/test_s013.py", "tests/test_s02.py", "other/test_s01.py"]) expect(r.test(no), no).toBe(false);
  });

  it("keeps * inside one directory and lets ** cross them", () => {
    expect(globRegex("tests/e2e/{slice}-*.spec.ts", "S-01").test("tests/e2e/s01-home.spec.ts")).toBe(true);
    expect(globRegex("tests/e2e/{slice}-*.spec.ts", "S-01").test("tests/e2e/x/s01-home.spec.ts")).toBe(false);
  });

  it("selects exactly what the old matcher selected, for the built-in recipes", () => {
    write("tests/test_s01_a.py", "");
    write("tests/test_s01_b.py", "");
    write("tests/test_s013.py", "");
    write("tests/__pycache__/test_s01_a.cpython-313.pyc", "");
    const slice = { id: "S-01", name: "n", criterionIds: ["AC-1"], prerequisites: [] };
    expect(sliceTestFiles("p", slice, env).sort()).toEqual(["tests/test_s01_a.py", "tests/test_s01_b.py"]);
  });

  it("matches a follow-up's own tests to the step that runs them", () => {
    const [unit, browser] = gateSteps({
      gate: [
        { name: "unit", run: ["npx", "vitest", "run"], files: "tests/{slice}-*.test.ts" },
        { name: "browser", run: ["npx", "playwright", "test"], files: "tests/e2e/{slice}-*.spec.ts" },
      ],
      render: [],
      smoke: [],
    });
    expect(stepCovers(browser, "tests/e2e/feedback-tower.spec.ts")).toBe(true);
    expect(stepCovers(unit, "tests/e2e/feedback-tower.spec.ts")).toBe(false);
  });
});

describe("a slice's gate, run from a declared contract", () => {
  const slice = { id: "S-01", name: "n", criterionIds: ["AC-1"], prerequisites: [] };

  it("runs each step, giving each scoped step only the slice's own files for it", () => {
    const seen = path.join(dir, "seen.txt");
    contract({
      gate: [
        { name: "lint", run: node("process.exit(0)") },
        { name: "unit", run: node(`require('fs').appendFileSync(${JSON.stringify(seen)}, 'unit:' + process.argv.slice(1).join(',') + '\\n')`), files: "tests/{slice}-*.test.ts" },
        { name: "browser", run: node(`require('fs').appendFileSync(${JSON.stringify(seen)}, 'browser:' + process.argv.slice(1).join(',') + '\\n')`), files: "tests/e2e/{slice}-*.spec.ts" },
      ],
    });
    write("tests/s01-a.test.ts", "");
    write("tests/s02-a.test.ts", "");
    write("tests/e2e/s01-home.spec.ts", "");
    lockTests("p", "tests", env);

    const result = runVerify("p", "a web app, Vite and React", slice, env);
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(seen, "utf8")).toBe("unit:tests/s01-a.test.ts\nbrowser:tests/e2e/s01-home.spec.ts\n");
  });

  it("skips a scoped step the slice has no files for, instead of running it unscoped", () => {
    contract({
      gate: [
        { name: "unit", run: node("process.exit(0)"), files: "tests/{slice}-*.test.ts" },
        { name: "browser", run: node("process.exit(9)"), files: "tests/e2e/{slice}-*.spec.ts" },
      ],
    });
    write("tests/s01-a.test.ts", "");
    lockTests("p", "tests", env);
    const result = runVerify("p", "a web app", slice, env);
    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => s.name)).toEqual(["unit"]);
  });

  it("is graded on the contract, not on a recipe sfo carries, whatever the archetype is called", () => {
    contract({ gate: [{ name: "unit", run: node("process.exit(0)"), files: "tests/{slice}*" }] });
    expect(verifiabilityProblem("p", "firmware for a MagTag", env)).toBeNull();
    expect(gateFor("p", env, "firmware for a MagTag").map((s) => s.name)).toEqual(["unit"]);
  });

  it("is locked with the tests, so a build agent cannot drop the step it keeps failing", () => {
    contract({ gate: [{ name: "unit", run: node("process.exit(0)"), files: "tests/{slice}*" }] });
    write("tests/s01.test.ts", "");
    lockTests("p", "tests", env);
    contract({ gate: [{ name: "unit", run: node("process.exit(0)"), files: "tests/nothing-{slice}" }] });
    expect(verifyTestLock("p", "tests", env)).toEqual([".sfo/CONTRACTS.json"]);
  });
});

describe("a declared install", () => {
  it("runs the project's install, then each check from a new login shell, arguments as data", () => {
    contract({
      gate: [{ name: "unit", run: ["true"], files: "tests/{slice}*" }],
      install: { run: ["npm", "link"], check: [["tower", "--version"]] },
    });
    const calls: string[][] = [];
    const run: Exec = (command, args) => {
      calls.push([command, ...args]);
      return { status: 0, output: "" };
    };
    const record = installTool("p", "a web app", { ...env, SHELL: "/bin/zsh" }, run);
    expect(calls).toEqual([
      ["npm", "link"],
      ["/bin/zsh", "-lc", '"$@"', "sfo", "tower", "--version"],
    ]);
    expect(record.commands).toEqual([{ name: "tower --version", installed: true, detail: "runs from a new terminal" }]);
  });

  it("is deferred, untouched, when it needs what the run does not have", () => {
    contract({
      gate: [{ name: "unit", run: ["true"], files: "tests/{slice}*" }],
      install: { run: ["pio", "run", "-t", "upload"], check: [], needs: ["hardware: Adafruit MagTag on USB"] },
    });
    const run: Exec = () => {
      throw new Error("nothing should run");
    };
    expect(installTool("p", "firmware", env, run)).toMatchObject({ deferred: ["hardware: Adafruit MagTag on USB"], commands: [] });
  });
});

describe("declared renders", () => {
  it("keeps what each prints and copies the files it produces", () => {
    contract({
      gate: [{ name: "unit", run: ["true"], files: "tests/{slice}*" }],
      render: [{ name: "home, dark", run: ["npx", "playwright", "test", "render.spec.ts"], produces: ["render/out/home-dark.png"] }],
    });
    const run: Run = () => {
      write("render/out/home-dark.png", "png");
      return { status: 0, stdout: Buffer.from("1 passed\n"), stderr: "" };
    };
    const [r] = captureRenders("p", "a web app", env, run);
    expect(r).toMatchObject({ text: "renders/1.txt", images: ["renders/1-home-dark.png"] });
    expect(fs.existsSync(path.join(dir, ".sfo", "renders", "1-home-dark.png"))).toBe(true);
  });
});
