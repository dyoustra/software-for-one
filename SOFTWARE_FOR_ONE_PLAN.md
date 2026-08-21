# Software For One — Implementation Plan (Phase 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `sfo` CLI through the front half of the pipeline — capture an idea, triage it, research it, produce a spec with acceptance criteria, and answer clarifying questions — so a real idea can go from a text dump to a reviewed `SPEC.md` without a human touching the pipeline in between.

**Architecture:** A stage machine where every stage is a fresh `claude -p` subprocess reading and writing markdown artifacts under `.sfo/` inside each project's own git repo. `state.json` is the only mutable coordination point; there is no daemon and no database. The runner is a process boundary, so a second agent harness is a second implementation of one interface.

**Tech Stack:** TypeScript (Node 24, ESM) · commander · zod · vitest · `@anthropic-ai/sdk` (triage only) · `claude` CLI as the agent runner

**Scope:** Phase 1 covers `capture → triage → research → spec → clarify`. Phase 2 (`plan → build → verify → review → deliver`) is a separate plan and depends on this one's artifacts.

---

## File Structure

| Path | Responsibility |
|---|---|
| `src/cli.ts` | Commander wiring and process entry. No logic. |
| `src/core/paths.ts` | Where projects live on disk. Single source of every path. |
| `src/core/state.ts` | `state.json` schema, atomic read/write, liveness. |
| `src/core/stages.ts` | Stage names, ordering, terminal checks. Pure. |
| `src/core/artifacts.ts` | Read/write/append `.sfo/*.md`. Enforces append-only files. |
| `src/core/orchestrator.ts` | Advances a project one stage at a time until blocked or done. |
| `src/runner/types.ts` | The `Runner` interface. One file so the contract is obvious. |
| `src/runner/claude-code.ts` | Spawns `claude -p`. The only file that knows the binary exists. |
| `src/stages/triage.ts` | Single structured API call. No agent loop. |
| `src/stages/prompts/*.md` | One prompt per agentic stage. Data, not code. |
| `src/commands/*.ts` | One file per CLI command. Thin — they call core. |
| `tests/**` | Mirrors `src/`. |

Two boundaries do the heavy lifting: **`core/` never spawns processes** (so it's testable without a model), and **`runner/` never knows what a stage is** (so a second harness is additive).

---

## Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Create: `src/cli.ts`
- Test: `tests/cli.test.ts`

- [ ] **Step 1: Initialize and install**

```bash
cd "/Users/dannyyoustra/Documents/Software For One"
npm init -y
npm install commander zod @anthropic-ai/sdk
npm install -D typescript vitest @types/node tsx
```

- [ ] **Step 2: Write config files**

`package.json` — replace the generated file's fields with these (keep the generated `dependencies`/`devDependencies` blocks):

```json
{
  "name": "software-for-one",
  "version": "0.1.0",
  "type": "module",
  "bin": { "sfo": "./dist/cli.js" },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "sfo": "tsx src/cli.ts"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": false,
    "types": ["node"]
  },
  "include": ["src/**/*"]
}
```

`vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
});
```

`.gitignore`:

```
node_modules/
dist/
*.tmp
```

- [ ] **Step 3: Write the failing test**

`tests/cli.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildProgram } from "../src/cli.js";

describe("buildProgram", () => {
  it("registers the expected commands", () => {
    const names = buildProgram().commands.map((c) => c.name());
    expect(names).toContain("new");
    expect(names).toContain("run");
    expect(names).toContain("status");
  });
});
```

- [ ] **Step 4: Run it and confirm it fails**

Run: `npm test`
Expected: FAIL — `Failed to resolve import "../src/cli.js"`

- [ ] **Step 5: Write the minimal implementation**

`src/cli.ts`:

```typescript
import { Command } from "commander";

export function buildProgram(): Command {
  const program = new Command();
  program.name("sfo").description("Software For One").version("0.1.0");

  program.command("new").description("Capture an idea and start a run");
  program.command("run").description("Advance a project");
  program.command("status").description("Show all projects");

  return program;
}

const isEntry = process.argv[1]?.endsWith("cli.ts") || process.argv[1]?.endsWith("cli.js");
if (isEntry) buildProgram().parse();
```

- [ ] **Step 6: Run it and confirm it passes**

Run: `npm test`
Expected: PASS — 1 test

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: scaffold sfo CLI with commander and vitest"
```

---

## Task 2: Paths

**Files:**
- Create: `src/core/paths.ts`
- Test: `tests/core/paths.test.ts`

**Design note:** every path in the system derives from one root, and the root is overridable by env var. That single choice is what makes every later test able to run against a temp directory instead of the user's real projects.

- [ ] **Step 1: Write the failing test**

`tests/core/paths.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { projectsRoot, projectDir, sfoDir, artifactPath, logPath } from "../../src/core/paths.js";

describe("paths", () => {
  it("honours SFO_HOME", () => {
    expect(projectsRoot({ SFO_HOME: "/tmp/x" })).toBe("/tmp/x");
  });

  it("defaults under the home directory", () => {
    expect(projectsRoot({ HOME: "/Users/ada" })).toBe("/Users/ada/.sfo");
  });

  it("derives project paths from the root", () => {
    const env = { SFO_HOME: "/tmp/x" };
    expect(projectDir("abc", env)).toBe("/tmp/x/abc");
    expect(sfoDir("abc", env)).toBe("/tmp/x/abc/.sfo");
    expect(artifactPath("abc", "SPEC.md", env)).toBe("/tmp/x/abc/.sfo/SPEC.md");
    expect(logPath("abc", "research", env)).toBe("/tmp/x/abc/.sfo/logs/research.log");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/core/paths.test.ts`
Expected: FAIL — cannot resolve `../../src/core/paths.js`

- [ ] **Step 3: Write the implementation**

`src/core/paths.ts`:

```typescript
import path from "node:path";
import os from "node:os";

export type Env = Record<string, string | undefined>;

export function projectsRoot(env: Env = process.env): string {
  return env.SFO_HOME ?? path.join(env.HOME ?? os.homedir(), ".sfo");
}

export function projectDir(id: string, env: Env = process.env): string {
  return path.join(projectsRoot(env), id);
}

export function sfoDir(id: string, env: Env = process.env): string {
  return path.join(projectDir(id, env), ".sfo");
}

export function artifactPath(id: string, name: string, env: Env = process.env): string {
  return path.join(sfoDir(id, env), name);
}

export function logPath(id: string, stage: string, env: Env = process.env): string {
  return path.join(sfoDir(id, env), "logs", `${stage}.log`);
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run tests/core/paths.test.ts`
Expected: PASS — 3 tests

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: path resolution rooted at SFO_HOME"
```

---

## Task 3: State

**Files:**
- Create: `src/core/state.ts`
- Test: `tests/core/state.test.ts`

**Design note:** the write is atomic (temp file + rename) because a crash mid-write on the *one* mutable file in the system would otherwise orphan a project with no way to tell what stage it reached.

- [ ] **Step 1: Write the failing test**

`tests/core/state.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeState, readState, isStale, type ProjectState } from "../../src/core/state.js";

let home: string;
let env: Record<string, string>;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "sfo-"));
  env = { SFO_HOME: home };
});

function sample(): ProjectState {
  return {
    id: "test-abc123",
    title: "Test idea",
    currentStage: "capture",
    status: "awaiting_human",
    attempts: {},
    pid: null,
    heartbeatAt: null,
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
  };
}

describe("state", () => {
  it("round-trips through disk", () => {
    fs.mkdirSync(path.join(home, "test-abc123", ".sfo"), { recursive: true });
    writeState(sample(), env);
    expect(readState("test-abc123", env).title).toBe("Test idea");
  });

  it("leaves no temp file behind", () => {
    fs.mkdirSync(path.join(home, "test-abc123", ".sfo"), { recursive: true });
    writeState(sample(), env);
    const files = fs.readdirSync(path.join(home, "test-abc123", ".sfo"));
    expect(files).toEqual(["state.json"]);
  });

  it("rejects a malformed state file", () => {
    fs.mkdirSync(path.join(home, "bad", ".sfo"), { recursive: true });
    fs.writeFileSync(path.join(home, "bad", ".sfo", "state.json"), '{"id":1}');
    expect(() => readState("bad", env)).toThrow(/invalid state/i);
  });

  it("treats a running project with an old heartbeat as stale", () => {
    const s = { ...sample(), status: "running" as const, pid: 999999, heartbeatAt: "2020-01-01T00:00:00.000Z" };
    expect(isStale(s, new Date("2026-08-21T00:00:00.000Z"))).toBe(true);
  });

  it("does not call a fresh heartbeat stale", () => {
    const s = { ...sample(), status: "running" as const, pid: 999999, heartbeatAt: "2026-08-21T00:00:00.000Z" };
    expect(isStale(s, new Date("2026-08-21T00:00:30.000Z"))).toBe(false);
  });

  it("never calls a non-running project stale", () => {
    expect(isStale(sample(), new Date("2030-01-01T00:00:00.000Z"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/core/state.test.ts`
Expected: FAIL — cannot resolve `../../src/core/state.js`

- [ ] **Step 3: Write the implementation**

`src/core/state.ts`:

```typescript
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { artifactPath, sfoDir, type Env } from "./paths.js";

export const STALE_AFTER_MS = 120_000;

export const ProjectStateSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  currentStage: z.string(),
  status: z.enum(["running", "awaiting_human", "failed", "done"]),
  attempts: z.record(z.string(), z.number()),
  pid: z.number().nullable(),
  heartbeatAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ProjectState = z.infer<typeof ProjectStateSchema>;

export function writeState(state: ProjectState, env?: Env): void {
  const target = artifactPath(state.id, "state.json", env);
  const tmp = `${target}.tmp`;
  fs.mkdirSync(sfoDir(state.id, env), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, target);
}

export function readState(id: string, env?: Env): ProjectState {
  const raw = fs.readFileSync(artifactPath(id, "state.json", env), "utf8");
  const parsed = ProjectStateSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`invalid state for project ${id}: ${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * A project marked `running` whose heartbeat has gone quiet was killed without
 * getting to update its own state. There is no other way to distinguish that
 * from a live run, so the heartbeat is what makes `sfo run` safe to resume.
 */
export function isStale(state: ProjectState, now: Date = new Date()): boolean {
  if (state.status !== "running") return false;
  if (!state.heartbeatAt) return true;
  return now.getTime() - new Date(state.heartbeatAt).getTime() > STALE_AFTER_MS;
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run tests/core/state.test.ts`
Expected: PASS — 6 tests

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: atomic project state with heartbeat liveness"
```

---

## Task 4: Stage ordering

**Files:**
- Create: `src/core/stages.ts`
- Test: `tests/core/stages.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/core/stages.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { PHASE_1_STAGES, nextStage, blocksOnHuman } from "../../src/core/stages.js";

describe("stages", () => {
  it("orders the phase 1 pipeline", () => {
    expect(PHASE_1_STAGES).toEqual(["capture", "research", "spec", "clarify"]);
  });

  it("advances through the pipeline", () => {
    expect(nextStage("capture")).toBe("research");
    expect(nextStage("research")).toBe("spec");
  });

  it("returns null at the end of the phase", () => {
    expect(nextStage("clarify")).toBeNull();
  });

  it("marks only clarify as blocking on a human", () => {
    expect(blocksOnHuman("clarify")).toBe(true);
    expect(blocksOnHuman("research")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/core/stages.test.ts`
Expected: FAIL — cannot resolve `../../src/core/stages.js`

- [ ] **Step 3: Write the implementation**

`src/core/stages.ts`:

```typescript
export const PHASE_1_STAGES = ["capture", "research", "spec", "clarify"] as const;

export type Stage = (typeof PHASE_1_STAGES)[number];

const HUMAN_STAGES = new Set<string>(["clarify"]);

export function nextStage(stage: string): Stage | null {
  const i = PHASE_1_STAGES.indexOf(stage as Stage);
  if (i === -1) throw new Error(`unknown stage: ${stage}`);
  return PHASE_1_STAGES[i + 1] ?? null;
}

export function blocksOnHuman(stage: string): boolean {
  return HUMAN_STAGES.has(stage);
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run tests/core/stages.test.ts`
Expected: PASS — 4 tests

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: phase 1 stage ordering"
```

---

## Task 5: Artifacts

**Files:**
- Create: `src/core/artifacts.ts`
- Test: `tests/core/artifacts.test.ts`

**Design note:** the append-only invariant from the spec is enforced here, in code, rather than trusted to prompts. An agent that tries to rewrite `DECISIONS.md` gets an error instead of silently erasing history.

- [ ] **Step 1: Write the failing test**

`tests/core/artifacts.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeArtifact, readArtifact, appendArtifact, artifactExists } from "../../src/core/artifacts.js";

let env: Record<string, string>;

beforeEach(() => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sfo-"));
  env = { SFO_HOME: home };
  fs.mkdirSync(path.join(home, "p", ".sfo"), { recursive: true });
});

describe("artifacts", () => {
  it("writes and reads", () => {
    writeArtifact("p", "SPEC.md", "# Spec", env);
    expect(readArtifact("p", "SPEC.md", env)).toBe("# Spec");
  });

  it("reports existence", () => {
    expect(artifactExists("p", "SPEC.md", env)).toBe(false);
    writeArtifact("p", "SPEC.md", "x", env);
    expect(artifactExists("p", "SPEC.md", env)).toBe(true);
  });

  it("appends to an append-only artifact", () => {
    appendArtifact("p", "DECISIONS.md", "first", env);
    appendArtifact("p", "DECISIONS.md", "second", env);
    expect(readArtifact("p", "DECISIONS.md", env)).toBe("first\nsecond\n");
  });

  it("refuses to overwrite an append-only artifact", () => {
    appendArtifact("p", "DECISIONS.md", "first", env);
    expect(() => writeArtifact("p", "DECISIONS.md", "clobber", env)).toThrow(/append-only/i);
  });

  it("returns null for a missing artifact", () => {
    expect(readArtifact("p", "NOPE.md", env)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/core/artifacts.test.ts`
Expected: FAIL — cannot resolve `../../src/core/artifacts.js`

- [ ] **Step 3: Write the implementation**

`src/core/artifacts.ts`:

```typescript
import fs from "node:fs";
import { artifactPath, sfoDir, type Env } from "./paths.js";

const APPEND_ONLY = new Set(["DECISIONS.md", "TEST_CHANGES.md", "IDEA.md"]);

export function artifactExists(id: string, name: string, env?: Env): boolean {
  return fs.existsSync(artifactPath(id, name, env));
}

export function readArtifact(id: string, name: string, env?: Env): string | null {
  const p = artifactPath(id, name, env);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
}

export function writeArtifact(id: string, name: string, body: string, env?: Env): void {
  if (APPEND_ONLY.has(name) && artifactExists(id, name, env)) {
    throw new Error(`${name} is append-only; use appendArtifact`);
  }
  fs.mkdirSync(sfoDir(id, env), { recursive: true });
  fs.writeFileSync(artifactPath(id, name, env), body);
}

export function appendArtifact(id: string, name: string, body: string, env?: Env): void {
  fs.mkdirSync(sfoDir(id, env), { recursive: true });
  fs.appendFileSync(artifactPath(id, name, env), `${body}\n`);
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run tests/core/artifacts.test.ts`
Expected: PASS — 5 tests

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: artifact IO with enforced append-only files"
```

---

## Task 6: The runner interface and the Claude Code runner

**Files:**
- Create: `src/runner/types.ts`, `src/runner/claude-code.ts`
- Test: `tests/runner/claude-code.test.ts`, `tests/fixtures/fake-claude.sh`

**Design note:** the binary path is injectable. That is what lets the whole runner be tested against a shell-script stub with no API calls, and it is the same seam a second harness plugs into.

- [ ] **Step 1: Write the interface**

`src/runner/types.ts`:

```typescript
export interface RunStageInput {
  workdir: string;
  prompt: string;
  logPath: string;
  model?: string;
}

export interface StageResult {
  ok: boolean;
  exitCode: number;
  logPath: string;
}

export interface Runner {
  runStage(input: RunStageInput): Promise<StageResult>;
}
```

- [ ] **Step 2: Write the test fixture**

`tests/fixtures/fake-claude.sh`:

```bash
#!/bin/bash
# Stands in for the real `claude` binary. Echoes its args so the test can
# assert on them, and exits with whatever FAKE_EXIT says.
echo "ARGS: $*"
echo "CWD: $(pwd)"
exit "${FAKE_EXIT:-0}"
```

Then: `chmod +x tests/fixtures/fake-claude.sh`

- [ ] **Step 3: Write the failing test**

`tests/runner/claude-code.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeCodeRunner } from "../../src/runner/claude-code.js";

const FAKE = path.resolve("tests/fixtures/fake-claude.sh");
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sfo-run-"));
});

describe("ClaudeCodeRunner", () => {
  it("passes print mode, json output, and the model", async () => {
    const runner = new ClaudeCodeRunner({ bin: FAKE });
    const log = path.join(dir, "out.log");
    const res = await runner.runStage({ workdir: dir, prompt: "hello", logPath: log });

    expect(res.ok).toBe(true);
    const out = fs.readFileSync(log, "utf8");
    expect(out).toContain("--print");
    expect(out).toContain("--output-format json");
    expect(out).toContain("claude-opus-5");
    expect(out).toContain("hello");
  });

  it("runs in the project directory", async () => {
    const runner = new ClaudeCodeRunner({ bin: FAKE });
    const log = path.join(dir, "out.log");
    await runner.runStage({ workdir: dir, prompt: "x", logPath: log });
    expect(fs.readFileSync(log, "utf8")).toContain(fs.realpathSync(dir));
  });

  it("reports a non-zero exit as not ok", async () => {
    const runner = new ClaudeCodeRunner({ bin: FAKE, env: { FAKE_EXIT: "3" } });
    const res = await runner.runStage({
      workdir: dir,
      prompt: "x",
      logPath: path.join(dir, "out.log"),
    });
    expect(res.ok).toBe(false);
    expect(res.exitCode).toBe(3);
  });

  it("creates the log directory if missing", async () => {
    const runner = new ClaudeCodeRunner({ bin: FAKE });
    const log = path.join(dir, "nested", "deeper", "out.log");
    await runner.runStage({ workdir: dir, prompt: "x", logPath: log });
    expect(fs.existsSync(log)).toBe(true);
  });
});
```

- [ ] **Step 4: Run it and confirm it fails**

Run: `npx vitest run tests/runner/claude-code.test.ts`
Expected: FAIL — cannot resolve `../../src/runner/claude-code.js`

- [ ] **Step 5: Write the implementation**

`src/runner/claude-code.ts`:

```typescript
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Runner, RunStageInput, StageResult } from "./types.js";

export const DEFAULT_MODEL = "claude-opus-5";

export interface ClaudeCodeRunnerOptions {
  bin?: string;
  env?: Record<string, string>;
}

export class ClaudeCodeRunner implements Runner {
  private readonly bin: string;
  private readonly extraEnv: Record<string, string>;

  constructor(opts: ClaudeCodeRunnerOptions = {}) {
    this.bin = opts.bin ?? "claude";
    this.extraEnv = opts.env ?? {};
  }

  runStage(input: RunStageInput): Promise<StageResult> {
    fs.mkdirSync(path.dirname(input.logPath), { recursive: true });
    const log = fs.openSync(input.logPath, "a");

    const args = [
      "--print",
      "--output-format",
      "json",
      "--permission-mode",
      "acceptEdits",
      "--model",
      input.model ?? DEFAULT_MODEL,
      input.prompt,
    ];

    return new Promise((resolve) => {
      const child = spawn(this.bin, args, {
        cwd: input.workdir,
        env: { ...process.env, ...this.extraEnv },
        stdio: ["ignore", log, log],
      });

      child.on("close", (code) => {
        fs.closeSync(log);
        const exitCode = code ?? 1;
        resolve({ ok: exitCode === 0, exitCode, logPath: input.logPath });
      });

      child.on("error", () => {
        fs.closeSync(log);
        resolve({ ok: false, exitCode: 127, logPath: input.logPath });
      });
    });
  }
}
```

- [ ] **Step 6: Run it and confirm it passes**

Run: `npx vitest run tests/runner/claude-code.test.ts`
Expected: PASS — 4 tests

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: claude -p subprocess runner behind a Runner interface"
```

---

## Task 7: Triage

**Files:**
- Create: `src/stages/triage.ts`
- Test: `tests/stages/triage.test.ts`

**Design note:** triage is the one stage with no agent loop — a single structured call. The client is injected so the test needs no API key.

**Do not use the SDK's `zodOutputFormat` helper.** Verified against the installed versions (`@anthropic-ai/sdk` 0.120.0, `zod` 4.4.3): the helper demotes `enum` into a prose `description` string, so the model receives a hint rather than a hard constraint and could return any string for `verdict`. `zod`'s own `z.toJSONSchema()` emits a correct `enum`, so we build the schema from that and strip `$schema` (the API rejects unknown top-level keys). Client-side validation stays — `TriageResultSchema.parse` is what actually guarantees the shape.

- [ ] **Step 1: Write the failing test**

`tests/stages/triage.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { triage, TriageResultSchema, triageOutputSchema } from "../../src/stages/triage.js";

function fakeClient(payload: unknown) {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: JSON.stringify(payload) }],
      }),
    },
  };
}

describe("triageOutputSchema", () => {
  it("constrains verdict with a real JSON Schema enum, not a description", () => {
    const schema = triageOutputSchema() as any;
    expect(schema.properties.verdict.enum).toEqual([
      "ready",
      "underspecified",
      "out_of_scope",
    ]);
  });

  it("strips $schema, which the API rejects as an unknown key", () => {
    expect(triageOutputSchema()).not.toHaveProperty("$schema");
  });

  it("forbids extra properties", () => {
    expect((triageOutputSchema() as any).additionalProperties).toBe(false);
  });
});

describe("triage", () => {
  it("returns a ready verdict for a clear idea", async () => {
    const client = fakeClient({
      verdict: "ready",
      title: "Subway Tracker",
      reason: "Scope and platform are clear.",
      counterOffer: null,
    });
    const res = await triage("Build a subway arrival tracker for the L train", client as never);
    expect(res.verdict).toBe("ready");
    expect(res.title).toBe("Subway Tracker");
  });

  it("returns a counter-offer instead of rejecting an out-of-scope idea", async () => {
    const client = fakeClient({
      verdict: "out_of_scope",
      title: "Train An LLM",
      reason: "Training a foundation model is not buildable here.",
      counterOffer: "A local inference playground with a chat UI.",
    });
    const res = await triage("make an LLM", client as never);
    expect(res.verdict).toBe("out_of_scope");
    expect(res.counterOffer).toMatch(/playground/);
  });

  it("requests opus and passes the structured format", async () => {
    const client = fakeClient({ verdict: "ready", title: "T", reason: "r", counterOffer: null });
    await triage("anything", client as never);
    const args = client.messages.create.mock.calls[0][0];
    expect(args.model).toBe("claude-opus-5");
    expect(args.output_config.format.type).toBe("json_schema");
    expect(args.output_config.format.schema.properties.verdict.enum).toHaveLength(3);
  });

  it("throws when the response carries no text block", async () => {
    const client = { messages: { create: vi.fn().mockResolvedValue({ content: [] }) } };
    await expect(triage("x", client as never)).rejects.toThrow(/no text/i);
  });

  it("throws when the model returns a verdict outside the enum", async () => {
    const client = fakeClient({ verdict: "maybe", title: "t", reason: "r", counterOffer: null });
    await expect(triage("x", client as never)).rejects.toThrow();
  });

  it("accepts only the three known verdicts", () => {
    const bad = { verdict: "maybe", title: "t", reason: "r", counterOffer: null };
    expect(TriageResultSchema.safeParse(bad).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/stages/triage.test.ts`
Expected: FAIL — cannot resolve `../../src/stages/triage.js`

- [ ] **Step 3: Write the implementation**

`src/stages/triage.ts`:

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

export const TriageResultSchema = z.object({
  verdict: z.enum(["ready", "underspecified", "out_of_scope"]),
  title: z.string(),
  reason: z.string(),
  counterOffer: z.string().nullable(),
});

export type TriageResult = z.infer<typeof TriageResultSchema>;

/**
 * Built from zod's own JSON Schema output rather than the SDK's
 * `zodOutputFormat` helper: with zod v4 that helper demotes `enum` into a
 * prose `description`, which would leave `verdict` unconstrained at the API
 * level. `$schema` is stripped because the API rejects unknown top-level keys.
 */
export function triageOutputSchema(): Record<string, unknown> {
  const full = z.toJSONSchema(TriageResultSchema) as Record<string, unknown>;
  const { $schema: _ignored, ...schema } = full;
  return schema;
}

const SYSTEM = `You triage side-project ideas for a pipeline that autonomously builds working software.

Classify the idea:
- "ready" — buildable as described.
- "underspecified" — buildable, but so thin that the later question round will be doing all the work.
- "out_of_scope" — not something an autonomous coding pipeline can produce (training a foundation model, a business rather than software, anything needing hardware nobody has).

Never simply reject. For "out_of_scope", set counterOffer to the nearest thing this pipeline CAN build, phrased as a concrete alternative. Leave counterOffer null otherwise.

Also produce a short title (under 6 words) suitable for a directory name.`;

type TriageClient = Pick<Anthropic, "messages">;

export async function triage(idea: string, client: TriageClient): Promise<TriageResult> {
  const response = await client.messages.create({
    model: "claude-opus-5",
    max_tokens: 16000,
    system: SYSTEM,
    output_config: { format: { type: "json_schema", schema: triageOutputSchema() } },
    messages: [{ role: "user", content: idea }],
  });

  const block = response.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") {
    throw new Error("triage response contained no text block");
  }
  return TriageResultSchema.parse(JSON.parse(block.text));
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run tests/stages/triage.test.ts`
Expected: PASS — 8 tests

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: triage stage with a genuine JSON Schema enum constraint"
```

---

## Task 8: Stage prompts

**Files:**
- Create: `src/stages/prompts/research.md`, `src/stages/prompts/spec.md`, `src/stages/prompts/clarify.md`
- Create: `src/stages/prompts.ts`
- Test: `tests/stages/prompts.test.ts`

**Design note:** prompts are files, not string literals, because tuning them is the bulk of the work and you want to diff a prompt change in isolation.

- [ ] **Step 1: Write the failing test**

`tests/stages/prompts.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { loadPrompt } from "../../src/stages/prompts.js";

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
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/stages/prompts.test.ts`
Expected: FAIL — cannot resolve `../../src/stages/prompts.js`

- [ ] **Step 3: Write the prompt files**

`src/stages/prompts/research.md`:

```markdown
Read `.sfo/IDEA.md`. Research what already exists and what building this well would require.

Use web search. Cover:
- Existing products or open-source projects that do this. Link them. Say what each gets right and where it falls short.
- The libraries or APIs a good implementation would use, with the specific reason each is the right choice.
- Known gotchas: rate limits, auth requirements, licensing, platform restrictions, anything that has bitten people building this.
- Anything that makes this harder than it looks.

Write your findings to `.sfo/RESEARCH.md`. Be concrete and cite sources. If the idea turns out to be well-served by something that already exists, say so plainly — that is a useful finding, not a failure.

Write only `.sfo/RESEARCH.md`. Do not create any other files.
```

`src/stages/prompts/spec.md`:

```markdown
Read `.sfo/IDEA.md` and `.sfo/RESEARCH.md`. Produce a specification.

Write `.sfo/SPEC.md` containing:
- **What this is** — one paragraph.
- **User stories** — what someone actually does with it.
- **Acceptance criteria** — a numbered list, each item independently checkable by a test. Write them so a machine can verify them: "the list persists across a page reload", not "persistence works well". These are the contract that later verification checks against, so vagueness here is the most expensive mistake you can make in this stage.
- **Out of scope** — what this deliberately does not do.
- **Stack** — the archetype and slot choices, with a one-line reason for any deviation from the defaults.

Write `.sfo/QUESTIONS.md` containing questions for the human. Split them under two headings, `## Blocking` and `## Preference`:
- **Blocking** — the answer changes the architecture; guessing wrong wastes the build.
- **Preference** — you have picked a defensible default; the human can override it.

Format every question as:

    ### <question>
    - [ ] A — <option> — <tradeoff>
    - [ ] B — <option> — <tradeoff>
    - [ ] Other: ______

Aim for 5 to 10 questions total. Fewer than 5 means you are not thinking hard enough about what is genuinely ambiguous. More than 10 means you are pushing decisions to the human that you should own — for those, pick the defensible default and record it instead.

Append every default you chose to `.sfo/DECISIONS.md` in this format:

    ## <decision>
    - Chose: <what>
    - Considered: <alternatives>
    - Why: <reasoning>
    - blast_radius: local | structural | external

Write only those three files.
```

`src/stages/prompts/clarify.md`:

```markdown
Read `.sfo/SPEC.md`, `.sfo/QUESTIONS.md`, and `.sfo/ANSWERS.md`.

The human has answered the questions. Fold their answers into `.sfo/SPEC.md`, editing it in place — do not write a new document. Where an answer contradicts a default you previously chose, the answer wins.

Append each answered question to `.sfo/DECISIONS.md` in the standard format, with the human recorded as the decider.

If an answer opens a genuinely new ambiguity that would change the architecture, add it to `.sfo/QUESTIONS.md` under `## Blocking` and stop. Otherwise leave `.sfo/QUESTIONS.md` alone.

Write only `.sfo/SPEC.md`, `.sfo/QUESTIONS.md`, and `.sfo/DECISIONS.md`.
```

- [ ] **Step 4: Write the loader**

`src/stages/prompts.ts`:

```typescript
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export function loadPrompt(stage: string): string {
  const p = path.join(here, "prompts", `${stage}.md`);
  if (!fs.existsSync(p)) throw new Error(`no prompt for stage: ${stage}`);
  return fs.readFileSync(p, "utf8");
}
```

- [ ] **Step 5: Run it and confirm it passes**

Run: `npx vitest run tests/stages/prompts.test.ts`
Expected: PASS — 2 tests

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: stage prompts as versioned files"
```

---

## Task 9: Orchestrator

**Files:**
- Create: `src/core/orchestrator.ts`
- Test: `tests/core/orchestrator.test.ts`

**Design note:** the orchestrator takes a `Runner`, so the whole advance loop is testable with a fake that records calls and never touches a model.

- [ ] **Step 1: Write the failing test**

`tests/core/orchestrator.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { advance } from "../../src/core/orchestrator.js";
import { writeState, readState, type ProjectState } from "../../src/core/state.js";
import type { Runner, RunStageInput, StageResult } from "../../src/runner/types.js";

let env: Record<string, string>;

class FakeRunner implements Runner {
  calls: RunStageInput[] = [];
  constructor(private readonly ok = true) {}
  async runStage(input: RunStageInput): Promise<StageResult> {
    this.calls.push(input);
    return { ok: this.ok, exitCode: this.ok ? 0 : 1, logPath: input.logPath };
  }
}

function seed(stage: string): ProjectState {
  const s: ProjectState = {
    id: "p",
    title: "T",
    currentStage: stage,
    status: "awaiting_human",
    attempts: {},
    pid: null,
    heartbeatAt: null,
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
  };
  fs.mkdirSync(path.join(env.SFO_HOME, "p", ".sfo"), { recursive: true });
  writeState(s, env);
  return s;
}

beforeEach(() => {
  env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-orch-")) };
});

describe("advance", () => {
  it("runs every stage up to the human gate", async () => {
    seed("capture");
    const runner = new FakeRunner();
    await advance("p", runner, env);

    expect(runner.calls.map((c) => path.basename(c.logPath))).toEqual([
      "research.log",
      "spec.log",
    ]);
    expect(readState("p", env).currentStage).toBe("clarify");
    expect(readState("p", env).status).toBe("awaiting_human");
  });

  it("marks the project failed when a stage exits non-zero", async () => {
    seed("capture");
    await advance("p", new FakeRunner(false), env);
    const s = readState("p", env);
    expect(s.status).toBe("failed");
    expect(s.currentStage).toBe("research");
    expect(s.attempts.research).toBe(1);
  });

  it("records a heartbeat while running", async () => {
    seed("capture");
    await advance("p", new FakeRunner(), env);
    expect(readState("p", env).heartbeatAt).not.toBeNull();
  });

  it("clears pid when it stops", async () => {
    seed("capture");
    await advance("p", new FakeRunner(), env);
    expect(readState("p", env).pid).toBeNull();
  });

  it("runs the clarify stage once the human has answered", async () => {
    seed("spec");
    fs.writeFileSync(path.join(env.SFO_HOME, "p", ".sfo", "ANSWERS.md"), "# Answers");
    const runner = new FakeRunner();
    await advance("p", runner, env);

    expect(runner.calls.map((c) => path.basename(c.logPath))).toEqual(["clarify.log"]);
    expect(readState("p", env).status).toBe("done");
  });

  it("refuses to advance a project that is already done", async () => {
    seed("clarify");
    const s = readState("p", env);
    writeState({ ...s, status: "done" }, env);
    const runner = new FakeRunner();
    await advance("p", runner, env);
    expect(runner.calls).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/core/orchestrator.test.ts`
Expected: FAIL — cannot resolve `../../src/core/orchestrator.js`

- [ ] **Step 3: Write the implementation**

`src/core/orchestrator.ts`:

```typescript
import { readState, writeState } from "./state.js";
import { nextStage, blocksOnHuman } from "./stages.js";
import { artifactExists } from "./artifacts.js";
import { loadPrompt } from "../stages/prompts.js";
import { projectDir, logPath, type Env } from "./paths.js";
import type { Runner } from "../runner/types.js";

/** The artifact a human must produce before a blocking stage can run. */
const HUMAN_INPUT: Record<string, string> = { clarify: "ANSWERS.md" };

export async function advance(id: string, runner: Runner, env?: Env): Promise<void> {
  let state = readState(id, env);
  if (state.status === "done") return;

  while (true) {
    const upcoming = nextStage(state.currentStage);
    if (upcoming === null) {
      state = { ...state, status: "done", pid: null, updatedAt: new Date().toISOString() };
      writeState(state, env);
      return;
    }

    // A human stage waits for the human's artifact, then runs like any other.
    // Without the artifactExists check the stage would be skipped entirely:
    // we'd park at `clarify`, and the next `advance` would see nextStage() ===
    // null and mark the project done without ever folding answers into the spec.
    if (blocksOnHuman(upcoming) && !artifactExists(id, HUMAN_INPUT[upcoming], env)) {
      state = {
        ...state,
        currentStage: upcoming,
        status: "awaiting_human",
        pid: null,
        updatedAt: new Date().toISOString(),
      };
      writeState(state, env);
      return;
    }

    state = {
      ...state,
      currentStage: upcoming,
      status: "running",
      pid: process.pid,
      heartbeatAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    writeState(state, env);

    const result = await runner.runStage({
      workdir: projectDir(id, env),
      prompt: loadPrompt(upcoming),
      logPath: logPath(id, upcoming, env),
    });

    if (!result.ok) {
      state = {
        ...state,
        status: "failed",
        pid: null,
        attempts: { ...state.attempts, [upcoming]: (state.attempts[upcoming] ?? 0) + 1 },
        updatedAt: new Date().toISOString(),
      };
      writeState(state, env);
      return;
    }
  }
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run tests/core/orchestrator.test.ts`
Expected: PASS — 5 tests

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: orchestrator advances stages until blocked or done"
```

---

## Task 10: `sfo new`

**Files:**
- Create: `src/commands/new.ts`
- Modify: `src/cli.ts`
- Test: `tests/commands/new.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/commands/new.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createProject, slugify } from "../../src/commands/new.js";
import { readState } from "../../src/core/state.js";
import { readArtifact } from "../../src/core/artifacts.js";

let env: Record<string, string>;

beforeEach(() => {
  env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-new-")) };
});

const triageOk = vi.fn().mockResolvedValue({
  verdict: "ready",
  title: "Subway Tracker",
  reason: "clear",
  counterOffer: null,
});

describe("slugify", () => {
  it("makes a filesystem-safe slug", () => {
    expect(slugify("Subway Tracker!! v2")).toBe("subway-tracker-v2");
  });
});

describe("createProject", () => {
  it("writes IDEA.md and state.json", async () => {
    const id = await createProject("track the L train", triageOk, "aaa111", env);
    expect(id).toBe("subway-tracker-aaa111");
    expect(readArtifact(id, "IDEA.md", env)).toContain("track the L train");
    expect(readState(id, env).currentStage).toBe("capture");
  });

  it("initialises a git repo", async () => {
    const id = await createProject("track the L train", triageOk, "aaa111", env);
    expect(fs.existsSync(path.join(env.SFO_HOME, id, ".git"))).toBe(true);
  });

  it("stores the triage verdict as an artifact", async () => {
    const id = await createProject("track the L train", triageOk, "aaa111", env);
    expect(readArtifact(id, "TRIAGE.md", env)).toContain("ready");
  });

  it("still creates the project when triage says out of scope", async () => {
    const t = vi.fn().mockResolvedValue({
      verdict: "out_of_scope",
      title: "Train An LLM",
      reason: "not buildable",
      counterOffer: "an inference playground",
    });
    const id = await createProject("make an llm", t, "bbb222", env);
    expect(readState(id, env).status).toBe("awaiting_human");
    expect(readArtifact(id, "TRIAGE.md", env)).toContain("inference playground");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/commands/new.test.ts`
Expected: FAIL — cannot resolve `../../src/commands/new.js`

- [ ] **Step 3: Write the implementation**

`src/commands/new.ts`:

```typescript
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { projectDir, sfoDir, type Env } from "../core/paths.js";
import { writeState } from "../core/state.js";
import { writeArtifact, appendArtifact } from "../core/artifacts.js";
import type { TriageResult } from "../stages/triage.js";

export type TriageFn = (idea: string) => Promise<TriageResult>;

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export async function createProject(
  idea: string,
  runTriage: TriageFn,
  suffix: string,
  env?: Env,
): Promise<string> {
  const verdict = await runTriage(idea);
  const id = `${slugify(verdict.title)}-${suffix}`;

  const dir = projectDir(id, env);
  fs.mkdirSync(sfoDir(id, env), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });

  appendArtifact(id, "IDEA.md", idea, env);
  writeArtifact(
    id,
    "TRIAGE.md",
    [
      `# Triage`,
      ``,
      `- verdict: ${verdict.verdict}`,
      `- reason: ${verdict.reason}`,
      verdict.counterOffer ? `- counter-offer: ${verdict.counterOffer}` : ``,
      ``,
    ].join("\n"),
    env,
  );

  const now = new Date().toISOString();
  writeState(
    {
      id,
      title: verdict.title,
      currentStage: "capture",
      status: "awaiting_human",
      attempts: {},
      pid: null,
      heartbeatAt: null,
      createdAt: now,
      updatedAt: now,
    },
    env,
  );

  return id;
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run tests/commands/new.test.ts`
Expected: PASS — 5 tests

- [ ] **Step 5: Wire it into the CLI**

Replace the placeholder `new` command in `src/cli.ts`:

```typescript
import { Command } from "commander";
import { randomBytes } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { createProject } from "./commands/new.js";
import { triage } from "./stages/triage.js";

export function buildProgram(): Command {
  const program = new Command();
  program.name("sfo").description("Software For One").version("0.1.0");

  program
    .command("new")
    .description("Capture an idea and start a run")
    .argument("<idea>", "the idea, in your own words")
    .action(async (idea: string) => {
      const client = new Anthropic();
      const id = await createProject(idea, (text) => triage(text, client), randomBytes(3).toString("hex"));
      console.log(`captured: ${id}`);
    });

  program.command("run").description("Advance a project");
  program.command("status").description("Show all projects");

  return program;
}

const isEntry = process.argv[1]?.endsWith("cli.ts") || process.argv[1]?.endsWith("cli.js");
if (isEntry) buildProgram().parse();
```

- [ ] **Step 6: Verify the whole suite still passes**

Run: `npm test`
Expected: PASS — all tests green

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: sfo new captures an idea, triages it, and initialises the repo"
```

---

## Task 11: `sfo run`, `sfo status`, `sfo logs`

**Files:**
- Create: `src/commands/run.ts`, `src/commands/status.ts`, `src/commands/logs.ts`
- Modify: `src/cli.ts`
- Test: `tests/commands/status.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/commands/status.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listProjects, formatStatus } from "../../src/commands/status.js";
import { writeState } from "../../src/core/state.js";

let env: Record<string, string>;

function seed(id: string, stage: string, status: "running" | "awaiting_human" | "failed" | "done") {
  fs.mkdirSync(path.join(env.SFO_HOME, id, ".sfo"), { recursive: true });
  writeState(
    {
      id,
      title: id,
      currentStage: stage,
      status,
      attempts: {},
      pid: null,
      heartbeatAt: null,
      createdAt: "2026-08-21T00:00:00.000Z",
      updatedAt: "2026-08-21T00:00:00.000Z",
    },
    env,
  );
}

beforeEach(() => {
  env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-st-")) };
});

describe("listProjects", () => {
  it("returns an empty list when nothing exists", () => {
    expect(listProjects(env)).toEqual([]);
  });

  it("lists every project", () => {
    seed("a-111", "spec", "running");
    seed("b-222", "clarify", "awaiting_human");
    expect(listProjects(env).map((p) => p.id).sort()).toEqual(["a-111", "b-222"]);
  });

  it("skips directories with no state file", () => {
    seed("a-111", "spec", "running");
    fs.mkdirSync(path.join(env.SFO_HOME, "junk"), { recursive: true });
    expect(listProjects(env)).toHaveLength(1);
  });
});

describe("formatStatus", () => {
  it("flags a project that needs the human", () => {
    seed("b-222", "clarify", "awaiting_human");
    expect(formatStatus(listProjects(env))).toContain("needs you");
  });

  it("reports a stale running project rather than claiming it is live", () => {
    seed("c-333", "spec", "running");
    expect(formatStatus(listProjects(env))).toContain("stale");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/commands/status.test.ts`
Expected: FAIL — cannot resolve `../../src/commands/status.js`

- [ ] **Step 3: Write status**

`src/commands/status.ts`:

```typescript
import fs from "node:fs";
import { projectsRoot, type Env } from "../core/paths.js";
import { readState, isStale, type ProjectState } from "../core/state.js";

export function listProjects(env?: Env): ProjectState[] {
  const root = projectsRoot(env);
  if (!fs.existsSync(root)) return [];

  const out: ProjectState[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      out.push(readState(entry.name, env));
    } catch {
      // A directory with no readable state is not a project. Skip it silently —
      // `sfo status` must never fail because of unrelated junk in the root.
    }
  }
  return out;
}

export function formatStatus(projects: ProjectState[]): string {
  if (projects.length === 0) return "no projects yet — try `sfo new`";

  return projects
    .map((p) => {
      const label =
        p.status === "awaiting_human"
          ? "needs you"
          : p.status === "running" && isStale(p)
            ? "stale (no heartbeat)"
            : p.status;
      return `${p.id.padEnd(32)} ${p.currentStage.padEnd(10)} ${label}`;
    })
    .join("\n");
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run tests/commands/status.test.ts`
Expected: PASS — 5 tests

- [ ] **Step 5: Write run (detached) and logs**

`src/commands/run.ts`:

```typescript
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeCodeRunner } from "../runner/claude-code.js";
import { readState, isStale } from "../core/state.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Runs the pipeline in this process. Called by the detached child. */
export async function runAttached(id: string): Promise<void> {
  await advance(id, new ClaudeCodeRunner());
}

/** Forks a detached child and returns immediately. */
export function runDetached(id: string): number {
  const child = spawn(process.execPath, [path.join(here, "..", "cli.js"), "run", id, "--attach"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child.pid ?? -1;
}

export function guardAlreadyRunning(id: string): void {
  const state = readState(id);
  if (state.status === "running" && !isStale(state)) {
    throw new Error(`${id} is already running (pid ${state.pid}) — use \`sfo stop ${id}\` first`);
  }
}
```

`src/commands/logs.ts`:

```typescript
import fs from "node:fs";
import { spawn } from "node:child_process";
import { logPath } from "../core/paths.js";
import { readState } from "../core/state.js";

export function showLogs(id: string, follow: boolean): void {
  const stage = readState(id).currentStage;
  const file = logPath(id, stage);
  if (!fs.existsSync(file)) {
    console.log(`no log yet for stage ${stage}`);
    return;
  }
  if (follow) {
    spawn("tail", ["-f", file], { stdio: "inherit" });
  } else {
    process.stdout.write(fs.readFileSync(file, "utf8"));
  }
}
```

- [ ] **Step 6: Wire all three into the CLI**

Add to `buildProgram()` in `src/cli.ts`, replacing the placeholder `run` and `status` commands:

```typescript
  program
    .command("run")
    .description("Advance a project until done or blocked")
    .argument("<id>", "project id")
    .option("--attach", "run in this process and stream progress")
    .action(async (id: string, opts: { attach?: boolean }) => {
      const { runAttached, runDetached, guardAlreadyRunning } = await import("./commands/run.js");
      guardAlreadyRunning(id);
      if (opts.attach) {
        await runAttached(id);
      } else {
        console.log(`started (pid ${runDetached(id)})`);
      }
    });

  program
    .command("status")
    .description("Show all projects")
    .action(async () => {
      const { listProjects, formatStatus } = await import("./commands/status.js");
      console.log(formatStatus(listProjects()));
    });

  program
    .command("logs")
    .description("Show the current stage's log")
    .argument("<id>", "project id")
    .option("-f, --follow", "tail the log")
    .action(async (id: string, opts: { follow?: boolean }) => {
      const { showLogs } = await import("./commands/logs.js");
      showLogs(id, opts.follow ?? false);
    });
```

- [ ] **Step 7: Verify the suite and the build**

Run: `npm test && npm run build`
Expected: PASS — all tests green, `dist/` produced with no type errors

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat: sfo run (detached by default), status, and logs"
```

---

## Task 12: `sfo answer` and `sfo stage`

**Files:**
- Create: `src/commands/answer.ts`, `src/commands/stage.ts`
- Modify: `src/cli.ts`
- Test: `tests/commands/answer.test.ts`

**Design note:** `sfo answer` parses `QUESTIONS.md` rather than round-tripping through the model. The markdown checkbox format from the spec prompt is the wire format, which means the same file renders as a UI later with no parser change.

- [ ] **Step 1: Write the failing test**

`tests/commands/answer.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseQuestions, renderAnswers } from "../../src/commands/answer.js";

let env: Record<string, string>;

beforeEach(() => {
  env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-ans-")) };
});

const SAMPLE = `## Blocking

### Native app or web app?
- [ ] A — Web app — fastest to build and deploy
- [ ] B — Native iOS — better offline story
- [ ] Other: ______

## Preference

### Which colour scheme?
- [ ] A — Light — default
- [ ] B — Dark — easier at night
- [ ] Other: ______
`;

describe("parseQuestions", () => {
  it("extracts every question with its section", () => {
    const qs = parseQuestions(SAMPLE);
    expect(qs).toHaveLength(2);
    expect(qs[0].section).toBe("Blocking");
    expect(qs[0].text).toBe("Native app or web app?");
    expect(qs[1].section).toBe("Preference");
  });

  it("extracts the options without the checkbox syntax", () => {
    const qs = parseQuestions(SAMPLE);
    expect(qs[0].options[0]).toBe("A — Web app — fastest to build and deploy");
    expect(qs[0].options).toHaveLength(3);
  });

  it("returns nothing for an empty document", () => {
    expect(parseQuestions("")).toEqual([]);
  });
});

describe("renderAnswers", () => {
  it("pairs each question with its answer", () => {
    const qs = parseQuestions(SAMPLE);
    const out = renderAnswers(qs, ["A — Web app", "B — Dark"]);
    expect(out).toContain("### Native app or web app?");
    expect(out).toContain("A — Web app");
    expect(out).toContain("B — Dark");
  });

  it("throws when the answer count does not match", () => {
    const qs = parseQuestions(SAMPLE);
    expect(() => renderAnswers(qs, ["only one"])).toThrow(/expected 2/i);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/commands/answer.test.ts`
Expected: FAIL — cannot resolve `../../src/commands/answer.js`

- [ ] **Step 3: Write the implementation**

`src/commands/answer.ts`:

```typescript
import readline from "node:readline/promises";
import { readArtifact, writeArtifact } from "../core/artifacts.js";
import { readState, writeState } from "../core/state.js";
import type { Env } from "../core/paths.js";

export interface Question {
  section: string;
  text: string;
  options: string[];
}

export function parseQuestions(markdown: string): Question[] {
  const questions: Question[] = [];
  let section = "";
  let current: Question | null = null;

  for (const line of markdown.split("\n")) {
    const sectionMatch = /^##\s+(.+)$/.exec(line);
    const questionMatch = /^###\s+(.+)$/.exec(line);
    const optionMatch = /^-\s+\[\s*\]\s+(.+)$/.exec(line);

    if (sectionMatch) {
      section = sectionMatch[1].trim();
    } else if (questionMatch) {
      current = { section, text: questionMatch[1].trim(), options: [] };
      questions.push(current);
    } else if (optionMatch && current) {
      current.options.push(optionMatch[1].trim());
    }
  }
  return questions;
}

export function renderAnswers(questions: Question[], answers: string[]): string {
  if (questions.length !== answers.length) {
    throw new Error(`expected ${questions.length} answers, got ${answers.length}`);
  }
  return [
    "# Answers",
    "",
    ...questions.flatMap((q, i) => [`### ${q.text}`, "", answers[i], ""]),
  ].join("\n");
}

export async function promptForAnswers(id: string, env?: Env): Promise<void> {
  const raw = readArtifact(id, "QUESTIONS.md", env);
  if (!raw) throw new Error(`no QUESTIONS.md for ${id} — has the spec stage run?`);

  const questions = parseQuestions(raw);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answers: string[] = [];

  for (const q of questions) {
    console.log(`\n[${q.section}] ${q.text}`);
    q.options.forEach((o) => console.log(`  ${o}`));
    answers.push(await rl.question("> "));
  }
  rl.close();

  writeArtifact(id, "ANSWERS.md", renderAnswers(questions, answers), env);

  const state = readState(id, env);
  writeState({ ...state, status: "awaiting_human", updatedAt: new Date().toISOString() }, env);
  console.log(`\nanswers saved — run \`sfo run ${id}\` to fold them into the spec`);
}
```

`src/commands/stage.ts`:

```typescript
import { advance } from "../core/orchestrator.js";
import { ClaudeCodeRunner } from "../runner/claude-code.js";
import { loadPrompt } from "../stages/prompts.js";
import { projectDir, logPath } from "../core/paths.js";

/**
 * Re-runs one stage in isolation against the artifacts already on disk.
 * This is the payoff of artifacts-as-state: when a spec comes back wrong you
 * re-run `spec` alone and diff, instead of replaying the whole pipeline.
 */
export async function runSingleStage(id: string, stage: string): Promise<void> {
  const runner = new ClaudeCodeRunner();
  const result = await runner.runStage({
    workdir: projectDir(id),
    prompt: loadPrompt(stage),
    logPath: logPath(id, stage),
  });
  console.log(result.ok ? `${stage} ok` : `${stage} failed (exit ${result.exitCode})`);
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run tests/commands/answer.test.ts`
Expected: PASS — 5 tests

- [ ] **Step 5: Wire into the CLI**

Add to `buildProgram()`:

```typescript
  program
    .command("answer")
    .description("Answer a project's open questions")
    .argument("<id>", "project id")
    .action(async (id: string) => {
      const { promptForAnswers } = await import("./commands/answer.js");
      await promptForAnswers(id);
    });

  program
    .command("stage")
    .description("Re-run a single stage in isolation")
    .argument("<id>", "project id")
    .argument("<stage>", "stage name")
    .action(async (id: string, stage: string) => {
      const { runSingleStage } = await import("./commands/stage.js");
      await runSingleStage(id, stage);
    });
```

- [ ] **Step 6: Verify everything**

Run: `npm test && npm run build`
Expected: PASS — all tests green, clean build

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: sfo answer and sfo stage"
```

---

## Task 13: End-to-end smoke run

**Files:**
- Create: `docs/RUNBOOK.md`

This is the task that tells you whether any of the above works. It is manual on purpose — the point is to watch a real run.

- [ ] **Step 1: Build and link**

```bash
npm run build && npm link
```

- [ ] **Step 2: Capture a real idea**

```bash
export SFO_HOME="$HOME/.sfo"
sfo new "A web app that tracks which of my houseplants need watering, with a photo of each plant and a per-plant schedule I can adjust."
```

Expected: prints `captured: <id>`, and `~/.sfo/<id>/.sfo/` contains `IDEA.md`, `TRIAGE.md`, `state.json`.

- [ ] **Step 3: Run the pipeline attached, so you can watch it**

```bash
sfo run <id> --attach
```

Expected: research and spec stages run; the command returns with the project at stage `clarify`, status `awaiting_human`.

- [ ] **Step 4: Inspect the artifacts by hand**

```bash
cat ~/.sfo/<id>/.sfo/RESEARCH.md
cat ~/.sfo/<id>/.sfo/SPEC.md
cat ~/.sfo/<id>/.sfo/QUESTIONS.md
```

Check specifically: are the acceptance criteria in `SPEC.md` **machine-checkable**? Vague criteria here are the single most expensive defect in the whole system, because both verification stages in Phase 2 check against them. If they read like "the app works well", the spec prompt needs tuning before Phase 2 is worth starting.

- [ ] **Step 5: Answer the questions**

```bash
sfo answer <id>
sfo run <id> --attach
```

Expected: `ANSWERS.md` written, then `SPEC.md` updated in place with the answers folded in and `DECISIONS.md` appended to.

- [ ] **Step 6: Verify the detached path separately**

```bash
sfo new "A CLI that renames my screenshot files based on what is in them."
sfo run <id>          # returns immediately with a pid
sfo status            # shows the project as running
sfo logs <id> -f      # streams the current stage
```

- [ ] **Step 7: Record the cost per stage**

Measured during Task 6 with a trivial one-word prompt: **$0.29 per `claude -p` invocation**, of which essentially all is `cache_creation_input_tokens: 28779` — the default context (system prompt, tool schemas, CLAUDE.md discovery) written to a 1-hour ephemeral cache before any work happens.

Two consequences to verify in the real run:
- Stages running **within an hour of each other** should read that prefix from cache at roughly a tenth the price, so a 4-stage pipeline should cost far less than 4 x $0.29. Confirm this from the `cache_read_input_tokens` on stages 2-4.
- The `--bare` flag skips hooks, plugin sync, and CLAUDE.md auto-discovery, which would cut the prefix substantially. **Do not adopt it for build stages** — the archetype design depends on the project's own `AGENTS.md` being discovered. It may be worth it for research and spec, which need no project conventions. Measure before deciding.

Record actual per-stage cost in the runbook. This is the number the spec's funding-model question turns on.

- [ ] **Step 8: Write the runbook**

`docs/RUNBOOK.md` — record what you actually observed: how long each stage took, what the token cost was, which prompts needed tuning, and any stage that failed and why. This file is the input to Phase 2 planning.

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "docs: phase 1 runbook from first end-to-end run"
```

---

## Definition of done for Phase 1

- [ ] `npm test` green, `npm run build` clean
- [ ] `sfo new` → `sfo run` → `sfo answer` → `sfo run` completes on at least three real ideas
- [ ] `SPEC.md` acceptance criteria are machine-checkable on all three
- [ ] Question counts land in the 5–10 range without hand-holding
- [ ] `sfo stage <id> spec` re-runs cleanly against existing artifacts
- [ ] A killed run leaves a `running` state that `sfo status` correctly reports as stale

## Explicitly deferred to Phase 2

`plan` · `build` · `verify` · `review` · `deliver` stages · the archetype slot registry · the verification gate · test-change adjudication · adversarial review · the `ambiguity_policy` setting · `sfo stop`

`ambiguity_policy` is deferred because nothing before the build stage can hit a mid-build ambiguity — there is no build yet to interrupt.
