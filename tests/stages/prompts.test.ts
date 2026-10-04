import { describe, it, expect } from "vitest";
import { loadPrompt } from "../../src/stages/prompts.js";
import { ARCHETYPE_NAMES } from "../../src/core/archetype.js";
import { ARCHETYPE_FILE } from "../../src/core/stack.js";
import { VERIFY_FILE } from "../../src/core/verifyRecord.js";
import { ACCESS_FILE } from "../../src/core/access.js";
import { CONTESTS_FILE, CONTEST_FILE, RULING_FILE } from "../../src/core/contest.js";
import { SERVICES_FILE, CREDENTIALS_FILE, smokeTestFile } from "../../src/core/services.js";
import { SMOKE_FILE } from "../../src/core/smoke.js";
import { FINDINGS_FILE, REVIEW_TEST_DIR } from "../../src/core/findings.js";
import { PRESENTATION_FILE, RENDERS_FILE } from "../../src/core/presentation.js";
import { INSTALL_FILE } from "../../src/core/install.js";
import { SMOKE_DIR } from "../../src/core/archetype.js";

describe("loadPrompt", () => {
  it("loads each phase 1 agentic stage prompt", () => {
    for (const stage of ["research", "spec", "clarify"]) {
      expect(loadPrompt(stage).length).toBeGreaterThan(100);
    }
  });

  it("throws for an unknown stage", () => {
    expect(() => loadPrompt("nope")).toThrow(/no prompt/i);
  });
});

describe("prompts and the artifacts they are graded on", () => {
  it("tells the spec stage to record the stack where a machine can read it", () => {
    expect(loadPrompt("spec")).toContain(ARCHETYPE_FILE);
  });

  it("lets spec describe what it builds freely, and test-repair declare how it is verified", () => {
    // No list of kinds: an archetype name sfo does not know is fine, because
    // the project's own contract says how it is checked.
    expect(loadPrompt("spec")).not.toMatch(/must be \*\*exactly one\*\*/);
    expect(loadPrompt("spec")).toContain(".sfo/PREFERENCES.md");
    const repair = loadPrompt("test-repair");
    expect(repair).toContain(".sfo/CONTRACTS.json");
    // Worked examples for both built-in stacks, a web app and a board.
    for (const example of ['"uv", "sync"', '"npm", "ci"', '"playwright", "test"', '"pio", "test"']) expect(repair).toContain(example);
    // The rules the red check and the schema enforce, stated where the contract is written.
    expect(repair).toMatch(/must fail against your skeleton/);
    expect(repair).toMatch(/A gate step cannot declare `needs`/);
  });

  it("points deliver at an artifact that exists", () => {
    // It is told to lead with what does not work; a nonexistent input means it
    // invents the section or omits it.
    expect(loadPrompt("deliver")).toContain(VERIFY_FILE);
  });

  it("has spec ask the person to name the project, and follow ranked languages", () => {
    // lattice and moon were both the agent's names.
    const spec = loadPrompt("spec");
    expect(spec).toContain("What should it be called?");
    expect(spec).toMatch(/rank languages for a kind/);
  });

  it("lets clarify carry a renamed command into every file that names it", () => {
    // A command renamed at clarify left PRESENTATION.json on the old name,
    // and the render ran a command that did not exist.
    const clarify = loadPrompt("clarify");
    expect(clarify).toContain(".sfo/PRESENTATION.json");
    expect(clarify).toMatch(/Write only[^\n]*\.sfo\/PRESENTATION\.json/);
  });

  it("hands spec the access snapshot, and tells clarify not to re-ask it", () => {
    // Left to a spec that might or might not raise it, the first project built
    // a tool its owner had no credential to run.
    expect(loadPrompt("spec")).toContain(`.sfo/${ACCESS_FILE}`);
    expect(loadPrompt("clarify")).toContain(`.sfo/${ACCESS_FILE}`);
  });

  it("names the contest artifacts where the stages that use them will look", () => {
    expect(loadPrompt("deliver")).toContain(`.sfo/${CONTESTS_FILE}`);
    expect(loadPrompt("adjudicate")).toContain(`.sfo/${RULING_FILE}`);
    expect(loadPrompt("build")).toContain(`.sfo/${CONTEST_FILE}`);
  });

  it("hands the seam list from the stage that starts it to every stage that relies on it", () => {
    for (const stage of ["research", "spec", "test-write", "review", "deliver", "smoke"]) {
      expect(loadPrompt(stage), stage).toContain(`.sfo/${SERVICES_FILE}`);
    }
    expect(loadPrompt("clarify")).toContain(`.sfo/${CREDENTIALS_FILE}`);
    expect(loadPrompt("deliver")).toContain(`.sfo/${SMOKE_FILE}`);
  });

  it("tells test-write the smoke contract the smoke stage reads", () => {
    // The stage finds a seam's file by name, passes these variables, and parses
    // exactly these levels. A prompt that drifted from any of them produces
    // smoke tests the stage reports as never written, or never reporting.
    const tw = loadPrompt("test-write");
    const batch = { id: "anthropic-batch" } as Parameters<typeof smokeTestFile>[0];
    expect(tw).toContain(smokeTestFile(batch, "cli-python"));
    expect(tw).toContain(smokeTestFile(batch, "cli-node"));
    expect(tw).toContain(`${SMOKE_DIR}/`);
    expect(tw).toContain("SFO_SMOKE_RESULTS");
    expect(tw).toContain("SFO_SMOKE_ASYNC_WAIT_SECONDS");
    for (const level of ["completed", "accepted", "failed", "skipped"]) expect(tw).toContain(`\`${level}\``);
  });

  it("tells review where its findings and reproduction tests go, and deliver where to read them", () => {
    const review = loadPrompt("review");
    expect(review).toContain(`.sfo/${FINDINGS_FILE}`);
    expect(review).toContain(`${REVIEW_TEST_DIR}/test_r001_`);
    expect(loadPrompt("deliver")).toContain(`.sfo/${FINDINGS_FILE}`);
    expect(loadPrompt("review-repair").length).toBeGreaterThan(100);
  });

  it("carries presentation from spec to test-write, and renders to review and deliver", () => {
    expect(loadPrompt("spec")).toContain(`.sfo/${PRESENTATION_FILE}`);
    expect(loadPrompt("test-write")).toContain(`.sfo/${PRESENTATION_FILE}`);
    expect(loadPrompt("review")).toContain(`.sfo/${RENDERS_FILE}`);
    expect(loadPrompt("deliver")).toContain(`.sfo/${RENDERS_FILE}`);
    expect(loadPrompt("deliver")).toContain(`.sfo/${INSTALL_FILE}`);
  });
});
