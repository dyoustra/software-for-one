# Phase 2, Plan A — Formats and Gates

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the three artifacts that code parses onto real schemas, add the two pipeline gates that stop work before it gets expensive, and seed per-archetype ignores — so Plan B's build half has a stable foundation to parse.

**Architecture:** Structured artifacts are JSONL (append-friendly, survives a partial write, one bad line fails loudly instead of being skipped). Prose artifacts stay markdown. Every structured file gets a render command, following the `COST.jsonl` / `sfo cost` pattern already proven.

**Tech Stack:** Existing — TypeScript ESM, zod, commander, vitest.

**Why this comes first:** `plan`, `test-write` and `review` all parse the acceptance criteria. Changing that format after Plan B is built means re-running Phase 1 to regenerate a spec, at ~$4 each iteration. Doing it now means regenerating once.

**Spends no build money.** The only cost is one artifact regeneration at the end.

---

## File Structure

| Path | Responsibility |
|---|---|
| `src/core/jsonl.ts` | Generic JSONL read/append with schema validation. One place that knows the format. |
| `src/core/criteria.ts` | `CRITERIA.jsonl` schema and accessors. |
| `src/core/decisions.ts` | `DECISIONS.jsonl` schema and accessors. |
| `src/core/questions.ts` | `QUESTIONS.json` / `ANSWERS.json` schemas. Replaces the regex parser. |
| `src/core/priorart.ts` | `PRIOR_ART.json` schema and the pipeline verdict. |
| `src/commands/criteria.ts` | `sfo criteria` renderer. |
| `src/commands/decisions.ts` | `sfo decisions` renderer. |
| `src/stages/prompts/*.md` | Updated to emit the new formats. |

`src/core/artifacts.ts` keeps its append-only guard; the JSONL files join that set.

---

## Task 1: Generic JSONL helper

**Files:**
- Create: `src/core/jsonl.ts`
- Test: `tests/core/jsonl.test.ts`

**Design note:** one module owns the format so the three schemas don't each reinvent tolerant parsing. Corrupt lines fail loudly rather than being skipped — `COST.jsonl` skips them because a lost cost record is survivable, but a lost acceptance criterion silently shrinks the contract.

- [ ] **Step 1: Write the failing test**

`tests/core/jsonl.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { appendRecord, readRecords, writeRecords } from "../../src/core/jsonl.js";

const Rec = z.object({ id: z.string(), n: z.number() });
let file: string;

beforeEach(() => {
  file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sfo-jsonl-")), "r.jsonl");
});

describe("jsonl", () => {
  it("returns an empty list when the file does not exist", () => {
    expect(readRecords(file, Rec)).toEqual([]);
  });

  it("appends and reads back in order", () => {
    appendRecord(file, Rec, { id: "a", n: 1 });
    appendRecord(file, Rec, { id: "b", n: 2 });
    expect(readRecords(file, Rec).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("rejects a record that does not match the schema on write", () => {
    expect(() => appendRecord(file, Rec, { id: "a" } as never)).toThrow(/invalid record/i);
  });

  it("throws on a corrupt line rather than skipping it", () => {
    // A skipped criterion silently shrinks the contract the build is held to.
    fs.writeFileSync(file, '{"id":"a","n":1}\nNOT JSON\n');
    expect(() => readRecords(file, Rec)).toThrow(/line 2/i);
  });

  it("throws when a line is valid JSON but the wrong shape", () => {
    fs.writeFileSync(file, '{"id":"a","n":1}\n{"id":"b"}\n');
    expect(() => readRecords(file, Rec)).toThrow(/line 2/i);
  });

  it("ignores blank lines and a trailing newline", () => {
    fs.writeFileSync(file, '{"id":"a","n":1}\n\n');
    expect(readRecords(file, Rec)).toHaveLength(1);
  });

  it("writeRecords replaces the whole file", () => {
    appendRecord(file, Rec, { id: "a", n: 1 });
    writeRecords(file, Rec, [{ id: "z", n: 9 }]);
    expect(readRecords(file, Rec).map((r) => r.id)).toEqual(["z"]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/core/jsonl.test.ts`
Expected: FAIL — cannot resolve `../../src/core/jsonl.js`

- [ ] **Step 3: Write the implementation**

`src/core/jsonl.ts`:

```typescript
import fs from "node:fs";
import path from "node:path";
import type { z } from "zod";

export function readRecords<T>(file: string, schema: z.ZodType<T>): T[] {
  if (!fs.existsSync(file)) return [];

  const out: T[] = [];
  const lines = fs.readFileSync(file, "utf8").split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") continue;

    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error(`${path.basename(file)}: line ${i + 1} is not valid JSON`);
    }

    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`${path.basename(file)}: line ${i + 1} does not match schema: ${parsed.error.message}`);
    }
    out.push(parsed.data);
  }
  return out;
}

export function appendRecord<T>(file: string, schema: z.ZodType<T>, record: T): void {
  const parsed = schema.safeParse(record);
  if (!parsed.success) {
    throw new Error(`invalid record for ${path.basename(file)}: ${parsed.error.message}`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(parsed.data)}\n`);
}

export function writeRecords<T>(file: string, schema: z.ZodType<T>, records: T[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = records.map((r) => {
    const parsed = schema.safeParse(r);
    if (!parsed.success) {
      throw new Error(`invalid record for ${path.basename(file)}: ${parsed.error.message}`);
    }
    return JSON.stringify(parsed.data);
  });
  fs.writeFileSync(file, body.length > 0 ? `${body.join("\n")}\n` : "");
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run tests/core/jsonl.test.ts`
Expected: PASS — 7 tests

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: JSONL helper with strict schema validation"
```

---

## Task 2: Acceptance criteria

**Files:**
- Create: `src/core/criteria.ts`
- Test: `tests/core/criteria.test.ts`

**Design note:** `group` lives on each criterion because the spec stage produces the grouping. Plan B adds a `slice` field when `plan` refines it; the schema tolerates its absence now so Plan B is additive.

- [ ] **Step 1: Write the failing test**

`tests/core/criteria.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CriterionSchema, readCriteria, writeCriteria, groupCriteria } from "../../src/core/criteria.js";

let env: Record<string, string>;

beforeEach(() => {
  env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-crit-")) };
  fs.mkdirSync(path.join(env.SFO_HOME, "p", ".sfo"), { recursive: true });
});

const sample = [
  { id: "AC-001", group: "Enumeration", text: "A U+202F filename appears in the candidate set." },
  { id: "AC-002", group: "Enumeration", text: "Non-image files are excluded." },
  { id: "AC-003", group: "Naming", text: "Every produced filename is at most 255 bytes." },
];

describe("criteria", () => {
  it("round-trips through disk", () => {
    writeCriteria("p", sample, env);
    expect(readCriteria("p", env)).toHaveLength(3);
  });

  it("returns an empty list for a project with no criteria", () => {
    expect(readCriteria("p", env)).toEqual([]);
  });

  it("requires an id, a group, and text", () => {
    expect(CriterionSchema.safeParse({ id: "AC-001", group: "G" }).success).toBe(false);
    expect(CriterionSchema.safeParse({ id: "AC-001", group: "G", text: "t" }).success).toBe(true);
  });

  it("accepts an optional slice, so Plan B can add it without a migration", () => {
    expect(CriterionSchema.safeParse({ id: "AC-1", group: "G", text: "t", slice: "s1" }).success).toBe(true);
  });

  it("rejects duplicate ids, which would silently drop a criterion downstream", () => {
    const dupes = [sample[0], { ...sample[1], id: "AC-001" }];
    expect(() => writeCriteria("p", dupes, env)).toThrow(/duplicate/i);
  });

  it("groups in first-seen order, preserving the spec's sequence", () => {
    writeCriteria("p", sample, env);
    const groups = groupCriteria(readCriteria("p", env));
    expect([...groups.keys()]).toEqual(["Enumeration", "Naming"]);
    expect(groups.get("Enumeration")).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/core/criteria.test.ts`
Expected: FAIL — cannot resolve `../../src/core/criteria.js`

- [ ] **Step 3: Write the implementation**

`src/core/criteria.ts`:

```typescript
import { z } from "zod";
import { artifactPath, type Env } from "./paths.js";
import { readRecords, writeRecords } from "./jsonl.js";

export const CriterionSchema = z.object({
  id: z.string().min(1),
  group: z.string().min(1),
  text: z.string().min(1),
  /** Assigned by Plan B's `plan` stage when it refines the spec's grouping. */
  slice: z.string().optional(),
});

export type Criterion = z.infer<typeof CriterionSchema>;

export const CRITERIA_FILE = "CRITERIA.jsonl";

export function readCriteria(id: string, env?: Env): Criterion[] {
  return readRecords(artifactPath(id, CRITERIA_FILE, env), CriterionSchema);
}

export function writeCriteria(id: string, criteria: Criterion[], env?: Env): void {
  const seen = new Set<string>();
  for (const c of criteria) {
    if (seen.has(c.id)) {
      // Downstream stages key on id. A duplicate silently drops one criterion
      // from whatever consumes them, shrinking the contract the build must meet.
      throw new Error(`duplicate criterion id: ${c.id}`);
    }
    seen.add(c.id);
  }
  writeRecords(artifactPath(id, CRITERIA_FILE, env), CriterionSchema, criteria);
}

/** First-seen order, so the spec stage's sequence survives. */
export function groupCriteria(criteria: Criterion[]): Map<string, Criterion[]> {
  const groups = new Map<string, Criterion[]>();
  for (const c of criteria) {
    const existing = groups.get(c.group);
    if (existing) existing.push(c);
    else groups.set(c.group, [c]);
  }
  return groups;
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run tests/core/criteria.test.ts`
Expected: PASS — 6 tests

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: acceptance criteria as validated JSONL"
```

---

## Task 3: Decisions

**Files:**
- Create: `src/core/decisions.ts`
- Test: `tests/core/decisions.test.ts`

**Design note:** `decided_by` is required, never inferred from absence. `blast_radius` is an enum so the tap-to-change UI can filter on it without string matching.

- [ ] **Step 1: Write the failing test**

`tests/core/decisions.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DecisionSchema, appendDecision, readDecisions } from "../../src/core/decisions.js";

let env: Record<string, string>;

beforeEach(() => {
  env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-dec-")) };
  fs.mkdirSync(path.join(env.SFO_HOME, "p", ".sfo"), { recursive: true });
});

const decision = {
  id: "D-001",
  decision: "App-first slugs",
  chose: "leading segment is the application",
  considered: "subject-first; verbose descriptive names",
  why: "overrides the previous default; follows from the search question being settled",
  decided_by: "human" as const,
  blast_radius: "structural" as const,
  at: "2026-08-21T18:00:00.000Z",
};

describe("decisions", () => {
  it("appends rather than replacing", () => {
    appendDecision("p", decision, env);
    appendDecision("p", { ...decision, id: "D-002", decided_by: "agent" }, env);
    expect(readDecisions("p", env).map((d) => d.id)).toEqual(["D-001", "D-002"]);
  });

  it("requires decided_by — absence must never carry meaning", () => {
    const { decided_by: _omitted, ...without } = decision;
    expect(DecisionSchema.safeParse(without).success).toBe(false);
  });

  it("accepts only the three blast radius values", () => {
    expect(DecisionSchema.safeParse({ ...decision, blast_radius: "medium" }).success).toBe(false);
    for (const r of ["local", "structural", "external"]) {
      expect(DecisionSchema.safeParse({ ...decision, blast_radius: r }).success).toBe(true);
    }
  });

  it("accepts only agent or human as a decider", () => {
    expect(DecisionSchema.safeParse({ ...decision, decided_by: "someone" }).success).toBe(false);
  });

  it("returns an empty list for a project with no decisions", () => {
    expect(readDecisions("p", env)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/core/decisions.test.ts`
Expected: FAIL — cannot resolve `../../src/core/decisions.js`

- [ ] **Step 3: Write the implementation**

`src/core/decisions.ts`:

```typescript
import { z } from "zod";
import { artifactPath, type Env } from "./paths.js";
import { readRecords, appendRecord } from "./jsonl.js";

export const DecisionSchema = z.object({
  id: z.string().min(1),
  decision: z.string().min(1),
  chose: z.string().min(1),
  considered: z.string(),
  why: z.string().min(1),
  /**
   * Required. Writing it only for human overrides makes absence load-bearing,
   * and absence cannot be distinguished from a bug or a prompt-version skew.
   */
  decided_by: z.enum(["agent", "human"]),
  blast_radius: z.enum(["local", "structural", "external"]),
  at: z.string(),
});

export type Decision = z.infer<typeof DecisionSchema>;

export const DECISIONS_FILE = "DECISIONS.jsonl";

export function readDecisions(id: string, env?: Env): Decision[] {
  return readRecords(artifactPath(id, DECISIONS_FILE, env), DecisionSchema);
}

export function appendDecision(id: string, decision: Decision, env?: Env): void {
  appendRecord(artifactPath(id, DECISIONS_FILE, env), DecisionSchema, decision);
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run tests/core/decisions.test.ts`
Expected: PASS — 5 tests

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: decisions as validated JSONL with required decided_by"
```

---

## Task 4: Questions and answers as JSON

**Files:**
- Create: `src/core/questions.ts`
- Modify: `src/commands/answer.ts`
- Delete: the regex parser in `src/commands/answer.ts`
- Test: `tests/core/questions.test.ts`, update `tests/commands/answer.test.ts`

**Design note:** this retires `parseQuestions`, which had three documented silent-failure modes — pre-checked `- [x]` boxes skipped, indented options dropped, a question before any heading assigned an empty section. A schema removes the class rather than patching the cases.

- [ ] **Step 1: Write the failing test**

`tests/core/questions.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  QuestionsSchema,
  readQuestions,
  writeQuestions,
  readAnswers,
  writeAnswers,
} from "../../src/core/questions.js";

let env: Record<string, string>;

beforeEach(() => {
  env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-q-")) };
  fs.mkdirSync(path.join(env.SFO_HOME, "p", ".sfo"), { recursive: true });
});

const questions = {
  questions: [
    {
      id: "Q-001",
      section: "blocking" as const,
      text: "Rename in place, or write a copy?",
      context: "This determines whether the tool mutates your originals at all.",
      options: [
        { key: "A", label: "Rename in place", tradeoff: "fastest; 4000 irreversible mutations" },
        { key: "B", label: "Hardlink into a new dir", tradeoff: "originals untouched; two folders" },
      ],
    },
  ],
};

describe("questions", () => {
  it("round-trips through disk", () => {
    writeQuestions("p", questions, env);
    expect(readQuestions("p", env)?.questions[0].text).toBe("Rename in place, or write a copy?");
  });

  it("returns null when no questions exist", () => {
    expect(readQuestions("p", env)).toBeNull();
  });

  it("accepts only blocking or preference as a section", () => {
    const bad = { questions: [{ ...questions.questions[0], section: "maybe" }] };
    expect(QuestionsSchema.safeParse(bad).success).toBe(false);
  });

  it("requires at least two options per question", () => {
    const bad = { questions: [{ ...questions.questions[0], options: [{ key: "A", label: "x", tradeoff: "y" }] }] };
    expect(QuestionsSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects duplicate question ids", () => {
    const dupes = { questions: [questions.questions[0], questions.questions[0]] };
    expect(() => writeQuestions("p", dupes, env)).toThrow(/duplicate/i);
  });

  it("stores an answer as the raw string the human typed", () => {
    // Free text is the escape hatch that makes multiple choice tolerable.
    writeAnswers("p", { answers: [{ questionId: "Q-001", answer: "a, but with a --materialize flag" }] }, env);
    expect(readAnswers("p", env)?.answers[0].answer).toContain("--materialize");
  });

  it("returns null when no answers exist", () => {
    expect(readAnswers("p", env)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/core/questions.test.ts`
Expected: FAIL — cannot resolve `../../src/core/questions.js`

- [ ] **Step 3: Write the implementation**

`src/core/questions.ts`:

```typescript
import fs from "node:fs";
import { z } from "zod";
import { artifactPath, sfoDir, type Env } from "./paths.js";

export const OptionSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  tradeoff: z.string(),
});

export const QuestionSchema = z.object({
  id: z.string().min(1),
  section: z.enum(["blocking", "preference"]),
  text: z.string().min(1),
  context: z.string(),
  options: z.array(OptionSchema).min(2),
});

export const QuestionsSchema = z.object({ questions: z.array(QuestionSchema) });
export const AnswersSchema = z.object({
  answers: z.array(z.object({ questionId: z.string().min(1), answer: z.string() })),
});

export type Questions = z.infer<typeof QuestionsSchema>;
export type Answers = z.infer<typeof AnswersSchema>;

export const QUESTIONS_FILE = "QUESTIONS.json";
export const ANSWERS_FILE = "ANSWERS.json";

function readJson<T>(file: string, schema: z.ZodType<T>, label: string): T | null {
  if (!fs.existsSync(file)) return null;
  const parsed = schema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error(`invalid ${label}: ${parsed.error.message}`);
  return parsed.data;
}

function writeJson<T>(file: string, schema: z.ZodType<T>, value: T, label: string): void {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`invalid ${label}: ${parsed.error.message}`);
  fs.writeFileSync(file, `${JSON.stringify(parsed.data, null, 2)}\n`);
}

export function readQuestions(id: string, env?: Env): Questions | null {
  return readJson(artifactPath(id, QUESTIONS_FILE, env), QuestionsSchema, QUESTIONS_FILE);
}

export function writeQuestions(id: string, questions: Questions, env?: Env): void {
  const seen = new Set<string>();
  for (const q of questions.questions) {
    if (seen.has(q.id)) throw new Error(`duplicate question id: ${q.id}`);
    seen.add(q.id);
  }
  fs.mkdirSync(sfoDir(id, env), { recursive: true });
  writeJson(artifactPath(id, QUESTIONS_FILE, env), QuestionsSchema, questions, QUESTIONS_FILE);
}

export function readAnswers(id: string, env?: Env): Answers | null {
  return readJson(artifactPath(id, ANSWERS_FILE, env), AnswersSchema, ANSWERS_FILE);
}

export function writeAnswers(id: string, answers: Answers, env?: Env): void {
  fs.mkdirSync(sfoDir(id, env), { recursive: true });
  writeJson(artifactPath(id, ANSWERS_FILE, env), AnswersSchema, answers, ANSWERS_FILE);
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run tests/core/questions.test.ts`
Expected: PASS — 7 tests

- [ ] **Step 5: Rewrite `promptForAnswers` against the schema**

Replace the body of `src/commands/answer.ts`. Delete `parseQuestions`, `renderAnswers`, and the `Question` interface entirely — `src/core/questions.ts` owns this now.

```typescript
import readline from "node:readline/promises";
import { readQuestions, writeAnswers } from "../core/questions.js";
import { readState, writeState } from "../core/state.js";
import type { Env } from "../core/paths.js";

export async function promptForAnswers(id: string, env?: Env): Promise<void> {
  readState(id, env); // existence check: report a missing project by name

  const questions = readQuestions(id, env);
  if (!questions) {
    throw new Error(`no ${"QUESTIONS.json"} for ${id} — has the spec stage run?`);
  }
  if (questions.questions.length === 0) {
    throw new Error(
      `QUESTIONS.json for ${id} contains no questions — re-run the stage with \`sfo stage ${id} spec\``,
    );
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answers: { questionId: string; answer: string }[] = [];

  try {
    for (const q of questions.questions) {
      console.log(`\n[${q.section}] ${q.text}`);
      if (q.context) console.log(`  ${q.context}`);
      for (const o of q.options) console.log(`  ${o.key} — ${o.label} — ${o.tradeoff}`);
      answers.push({ questionId: q.id, answer: await rl.question("> ") });
    }
  } finally {
    rl.close();
  }

  writeAnswers(id, { answers }, env);

  const state = readState(id, env);
  writeState({ ...state, status: "awaiting_human", updatedAt: new Date().toISOString() }, env);
  console.log(`\nanswers saved — run \`sfo run ${id}\` to fold them into the spec`);
}
```

- [ ] **Step 6: Update `tests/commands/answer.test.ts`**

Delete the `parseQuestions` and `renderAnswers` describe blocks — those functions no longer exist. Keep the `promptForAnswers` block, changing `writeArtifact("p", "QUESTIONS.md", ...)` to `writeQuestions("p", {...}, env)` and adding a case for the zero-questions guard.

- [ ] **Step 7: Verify the suite and commit**

Run: `npm test && npm run build && npm run typecheck`
Expected: all clean, with the answer tests updated.

```bash
git add -A && git commit -m "feat: questions and answers as validated JSON, retiring the regex parser"
```

---

## Task 5: Renderers

**Files:**
- Create: `src/commands/criteria.ts`, `src/commands/decisions.ts`
- Modify: `src/cli.ts`
- Test: `tests/commands/criteria.test.ts`

**Design note:** structured storage plus a render command is the pattern `sfo cost` proved. You get schema validation and readable output; markdown gave neither guarantee.

- [ ] **Step 1: Write the failing test**

`tests/commands/criteria.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { formatCriteria } from "../../src/commands/criteria.js";
import { formatDecisions } from "../../src/commands/decisions.js";

const criteria = [
  { id: "AC-001", group: "Enumeration", text: "A U+202F filename appears in the candidate set." },
  { id: "AC-002", group: "Enumeration", text: "Non-image files are excluded." },
  { id: "AC-003", group: "Naming", text: "Filenames are at most 255 bytes." },
];

const decisions = [
  {
    id: "D-001", decision: "App-first slugs", chose: "app leads", considered: "subject-first",
    why: "browsing beats searching here", decided_by: "human" as const,
    blast_radius: "structural" as const, at: "2026-08-21T18:00:00.000Z",
  },
  {
    id: "D-002", decision: "Dry-run default", chose: "dry-run", considered: "apply by default",
    why: "destructive", decided_by: "agent" as const,
    blast_radius: "local" as const, at: "2026-08-21T18:00:00.000Z",
  },
];

describe("formatCriteria", () => {
  it("groups criteria under their headings with a count", () => {
    const out = formatCriteria(criteria);
    expect(out).toContain("Enumeration");
    expect(out).toContain("AC-001");
    expect(out).toMatch(/3 criteria/);
  });

  it("reports an empty set without crashing", () => {
    expect(formatCriteria([])).toMatch(/no criteria/i);
  });
});

describe("formatDecisions", () => {
  it("shows who decided and the blast radius", () => {
    const out = formatDecisions(decisions);
    expect(out).toContain("human");
    expect(out).toContain("structural");
  });

  it("puts structural and external decisions first", () => {
    // The expensive-to-reverse calls should be the first thing read, not
    // buried among forty local ones.
    const out = formatDecisions(decisions);
    expect(out.indexOf("D-001")).toBeLessThan(out.indexOf("D-002"));
  });

  it("reports an empty set without crashing", () => {
    expect(formatDecisions([])).toMatch(/no decisions/i);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/commands/criteria.test.ts`
Expected: FAIL — cannot resolve the command modules

- [ ] **Step 3: Write the implementations**

`src/commands/criteria.ts`:

```typescript
import { readCriteria, groupCriteria, type Criterion } from "../core/criteria.js";
import type { Env } from "../core/paths.js";

export function formatCriteria(criteria: Criterion[]): string {
  if (criteria.length === 0) return "no criteria yet — has the spec stage run?";

  const lines: string[] = [];
  for (const [group, items] of groupCriteria(criteria)) {
    lines.push(`\n${group}`);
    for (const c of items) lines.push(`  ${c.id.padEnd(8)} ${c.text}`);
  }
  lines.push(`\n${criteria.length} criteria in ${groupCriteria(criteria).size} groups`);
  return lines.join("\n");
}

export function showCriteria(id: string, env?: Env): void {
  console.log(formatCriteria(readCriteria(id, env)));
}
```

`src/commands/decisions.ts`:

```typescript
import { readDecisions, type Decision } from "../core/decisions.js";
import type { Env } from "../core/paths.js";

const RADIUS_ORDER: Record<Decision["blast_radius"], number> = {
  external: 0,
  structural: 1,
  local: 2,
};

export function formatDecisions(decisions: Decision[]): string {
  if (decisions.length === 0) return "no decisions recorded yet";

  // Expensive-to-reverse calls lead. Buried among forty local decisions, a
  // structural one goes unread, which defeats the point of recording it.
  const sorted = [...decisions].sort(
    (a, b) => RADIUS_ORDER[a.blast_radius] - RADIUS_ORDER[b.blast_radius],
  );

  return sorted
    .map((d) =>
      [
        `${d.id}  [${d.blast_radius}]  decided by ${d.decided_by}`,
        `  ${d.decision}`,
        `  chose: ${d.chose}`,
        `  why:   ${d.why}`,
      ].join("\n"),
    )
    .join("\n\n");
}

export function showDecisions(id: string, env?: Env): void {
  console.log(formatDecisions(readDecisions(id, env)));
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run tests/commands/criteria.test.ts`
Expected: PASS — 5 tests

- [ ] **Step 5: Wire into the CLI**

Add to `buildProgram()` in `src/cli.ts`, wrapped in the existing `guarded(...)` helper like every other action:

```typescript
  program
    .command("criteria")
    .description("Show a project's acceptance criteria")
    .argument("<id>", "project id")
    .action(guarded(async (id: string) => {
      const { showCriteria } = await import("./commands/criteria.js");
      showCriteria(id);
    }));

  program
    .command("decisions")
    .description("Show the calls the pipeline made, highest blast radius first")
    .argument("<id>", "project id")
    .action(guarded(async (id: string) => {
      const { showDecisions } = await import("./commands/decisions.js");
      showDecisions(id);
    }));
```

Update `tests/cli.test.ts` to assert both commands are registered.

- [ ] **Step 6: Verify and commit**

Run: `npm test && npm run build && npm run typecheck`

```bash
git add -A && git commit -m "feat: sfo criteria and sfo decisions renderers"
```

---

## Task 6: Teach the spec stage the new formats

**Files:**
- Modify: `src/stages/prompts/spec.md`, `src/stages/prompts/clarify.md`

**Design note:** no code changes — the stages write files, and the schemas validate on read. A stage that emits a malformed record fails loudly at the next read rather than silently degrading.

- [ ] **Step 1: Rewrite the spec prompt's output section**

In `src/stages/prompts/spec.md`, replace the `QUESTIONS.md` format block and the `DECISIONS.md` format block with:

```markdown
Write `.sfo/CRITERIA.jsonl` — one JSON object per line, no wrapping array:

    {"id":"AC-001","group":"Enumeration and file identification","text":"Given a directory containing a file whose name embeds U+202F, that file appears in the candidate set."}

`id` is `AC-` plus a zero-padded number, unique across the file. `group` is the
heading the criterion belongs under; keep related criteria in the same group and
order groups the way a person would build them. `text` is one self-contained
sentence that a test can check — it must make sense read alone, without the
group heading.

`.sfo/SPEC.md` keeps the prose and refers to criteria by id rather than
restating them.

Write `.sfo/QUESTIONS.json`:

    {"questions":[
      {"id":"Q-001","section":"blocking","text":"<question>","context":"<why this matters, 1-2 sentences>",
       "options":[{"key":"A","label":"<option>","tradeoff":"<what it costs>"}]}
    ]}

`section` is exactly `blocking` or `preference`. At least two options per
question. Do not add an "Other" option — free text is always accepted.

Append to `.sfo/DECISIONS.jsonl`, one object per line:

    {"id":"D-001","decision":"<short name>","chose":"<what>","considered":"<alternatives>","why":"<reasoning>","decided_by":"agent","blast_radius":"local","at":"<ISO 8601>"}

`decided_by` is required on every record, never omitted — absence cannot be
distinguished from a bug. `blast_radius` is exactly one of `local`,
`structural`, `external`.

Write only `.sfo/SPEC.md`, `.sfo/CRITERIA.jsonl`, `.sfo/QUESTIONS.json`, and
`.sfo/DECISIONS.jsonl`.
```

- [ ] **Step 2: Update the clarify prompt**

In `src/stages/prompts/clarify.md`, change the filenames it reads and writes: `.sfo/QUESTIONS.json`, `.sfo/ANSWERS.json`, `.sfo/DECISIONS.jsonl`. Answers arrive as `{"questionId":"Q-001","answer":"<raw text the human typed>"}` — the answer is free text and may not match any option key, so interpret it rather than matching it exactly. Records appended to `DECISIONS.jsonl` use `"decided_by":"human"`.

- [ ] **Step 3: Verify the build copies the prompts**

Run: `npm run build && ls dist/stages/prompts/`
Expected: all three `.md` files present.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(prompts): emit CRITERIA.jsonl, QUESTIONS.json, DECISIONS.jsonl"
```

---

## Task 7: Prior-art verdict

**Files:**
- Create: `src/core/priorart.ts`
- Modify: `src/stages/prompts/research.md`, `src/core/orchestrator.ts`
- Test: `tests/core/priorart.test.ts`, update `tests/core/orchestrator.test.ts`

**Design note:** the first real run produced 30KB of excellent research that nothing acted on. This makes the research stage able to stop the pipeline — the `no_gap` case saves the spec stage and, more importantly, the whole build.

- [ ] **Step 1: Write the failing test**

`tests/core/priorart.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PriorArtSchema, readPriorArt, writePriorArt, blocksPipeline } from "../../src/core/priorart.js";

let env: Record<string, string>;

beforeEach(() => {
  env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-pa-")) };
  fs.mkdirSync(path.join(env.SFO_HOME, "p", ".sfo"), { recursive: true });
});

const clear = {
  verdict: "clear_gap" as const,
  summary: "Nothing handles this at scale.",
  existing: [{ name: "ai-renamer", url: "https://example.com", gap: "no batching or resume" }],
};

describe("priorArt", () => {
  it("round-trips through disk", () => {
    writePriorArt("p", clear, env);
    expect(readPriorArt("p", env)?.verdict).toBe("clear_gap");
  });

  it("returns null when the research stage has not run", () => {
    expect(readPriorArt("p", env)).toBeNull();
  });

  it("accepts only the three verdicts", () => {
    expect(PriorArtSchema.safeParse({ ...clear, verdict: "probably" }).success).toBe(false);
  });

  it("requires a recommendation when the verdict is no_gap", () => {
    // Stopping without saying what to use instead is a dead end, which is the
    // thing this verdict exists to avoid.
    const noGap = { ...clear, verdict: "no_gap" as const };
    expect(PriorArtSchema.safeParse(noGap).success).toBe(false);
    expect(PriorArtSchema.safeParse({ ...noGap, recommendation: "use ai-renamer" }).success).toBe(true);
  });

  it("blocks the pipeline on no_gap and marginal_gap only", () => {
    expect(blocksPipeline("no_gap")).toBe(true);
    expect(blocksPipeline("marginal_gap")).toBe(true);
    expect(blocksPipeline("clear_gap")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/core/priorart.test.ts`
Expected: FAIL — cannot resolve `../../src/core/priorart.js`

- [ ] **Step 3: Write the implementation**

`src/core/priorart.ts`:

```typescript
import fs from "node:fs";
import { z } from "zod";
import { artifactPath, sfoDir, type Env } from "./paths.js";

export const PriorArtSchema = z
  .object({
    verdict: z.enum(["no_gap", "marginal_gap", "clear_gap"]),
    summary: z.string().min(1),
    existing: z.array(
      z.object({ name: z.string(), url: z.string(), gap: z.string() }),
    ),
    /** Required when the verdict is `no_gap`. */
    recommendation: z.string().optional(),
  })
  .refine((v) => v.verdict !== "no_gap" || (v.recommendation?.length ?? 0) > 0, {
    message: "no_gap requires a recommendation — stopping without naming what to use instead is a dead end",
  });

export type PriorArt = z.infer<typeof PriorArtSchema>;
export const PRIOR_ART_FILE = "PRIOR_ART.json";

export function readPriorArt(id: string, env?: Env): PriorArt | null {
  const file = artifactPath(id, PRIOR_ART_FILE, env);
  if (!fs.existsSync(file)) return null;
  const parsed = PriorArtSchema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error(`invalid ${PRIOR_ART_FILE}: ${parsed.error.message}`);
  return parsed.data;
}

export function writePriorArt(id: string, value: PriorArt, env?: Env): void {
  const parsed = PriorArtSchema.safeParse(value);
  if (!parsed.success) throw new Error(`invalid ${PRIOR_ART_FILE}: ${parsed.error.message}`);
  fs.mkdirSync(sfoDir(id, env), { recursive: true });
  fs.writeFileSync(
    artifactPath(id, PRIOR_ART_FILE, env),
    `${JSON.stringify(parsed.data, null, 2)}\n`,
  );
}

export function blocksPipeline(verdict: PriorArt["verdict"]): boolean {
  return verdict !== "clear_gap";
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run tests/core/priorart.test.ts`
Expected: PASS — 5 tests

- [ ] **Step 5: Gate the orchestrator on the verdict**

In `src/core/orchestrator.ts`, after a successful `research` stage and before advancing, park the project when the verdict blocks. Add to the imports:

```typescript
import { readPriorArt, blocksPipeline } from "./priorart.js";
```

Immediately after the `if (!result.ok) { ... }` block, before the loop continues:

```typescript
    // A research stage that concludes "this already exists" must be able to
    // stop the pipeline. Otherwise a 30KB prior-art document changes nothing
    // and the project spends the spec stage — and later the whole build —
    // rebuilding something the user could install today.
    if (upcoming === "research") {
      const priorArt = readPriorArt(id, env);
      if (priorArt && blocksPipeline(priorArt.verdict)) {
        state = {
          ...state,
          status: "awaiting_human",
          pid: null,
          updatedAt: new Date().toISOString(),
        };
        writeState(state, env);
        commitStage(id, upcoming, env);
        return;
      }
    }
```

- [ ] **Step 6: Add the orchestrator test**

Append to `tests/core/orchestrator.test.ts`:

```typescript
  it("stops after research when prior art says the gap is not real", async () => {
    seed("capture");
    const runner = new FakeRunner();
    // The fake runner does not write artifacts, so plant the verdict the real
    // research stage would have written.
    const write = () =>
      fs.writeFileSync(
        path.join(env.SFO_HOME, "p", ".sfo", "PRIOR_ART.json"),
        JSON.stringify({
          verdict: "no_gap",
          summary: "Several mature tools do exactly this.",
          existing: [{ name: "ai-renamer", url: "https://example.com", gap: "none" }],
          recommendation: "use ai-renamer",
        }),
      );
    write();

    await advance("p", runner, env);

    expect(runner.calls.map((c) => path.basename(c.logPath))).toEqual(["research.log"]);
    expect(readState("p", env).status).toBe("awaiting_human");
    expect(readState("p", env).currentStage).toBe("research");
  });
```

- [ ] **Step 7: Teach the research prompt to emit the verdict**

Append to `src/stages/prompts/research.md`:

```markdown
Finally, write `.sfo/PRIOR_ART.json` with your verdict:

    {"verdict":"clear_gap","summary":"<one paragraph>",
     "existing":[{"name":"<project>","url":"<link>","gap":"<what it does not do>"}],
     "recommendation":"<only when verdict is no_gap>"}

- `no_gap` — something existing already does this well enough that building it
  would be wasted effort. **`recommendation` is required**: name what to use
  instead. This stops the pipeline, so use it when you mean it.
- `marginal_gap` — the differences are real but small. This stops the pipeline
  and asks the person to decide.
- `clear_gap` — nothing existing covers this; the pipeline proceeds.

Be honest here. Concluding that an idea should not be built is a useful finding,
not a failure, and it is far cheaper to say so now than after a build.
```

- [ ] **Step 8: Verify and commit**

Run: `npm test && npm run build && npm run typecheck`

```bash
git add -A && git commit -m "feat: research emits a prior-art verdict that can stop the pipeline"
```

---

## Task 8: Rough cost estimate after triage

**Files:**
- Create: `src/core/estimate.ts`
- Modify: `src/commands/new.ts`, `src/stages/triage.ts`
- Test: `tests/core/estimate.test.ts`

**Design note:** the estimate is rough by construction — it knows only the idea's shape. Its job is to let you bail before the ~$4 front half, not to be accurate. The precise estimate lands in Plan B after `plan`, where slice and criterion counts are known.

- [ ] **Step 1: Write the failing test**

`tests/core/estimate.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EstimateSchema, readEstimate, writeEstimate, formatEstimate } from "../../src/core/estimate.js";

let env: Record<string, string>;

beforeEach(() => {
  env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-est-")) };
  fs.mkdirSync(path.join(env.SFO_HOME, "p", ".sfo"), { recursive: true });
});

const estimate = {
  phase: "front" as const,
  lowUsd: 3,
  highUsd: 6,
  basis: "Single-purpose CLI; research will need a few searches.",
  at: "2026-08-21T18:00:00.000Z",
};

describe("estimate", () => {
  it("round-trips through disk", () => {
    writeEstimate("p", estimate, env);
    expect(readEstimate("p", env)?.[0].lowUsd).toBe(3);
  });

  it("appends rather than replacing, so both estimates survive", () => {
    writeEstimate("p", estimate, env);
    writeEstimate("p", { ...estimate, phase: "build", lowUsd: 20, highUsd: 40 }, env);
    expect(readEstimate("p", env)).toHaveLength(2);
  });

  it("rejects a range where low exceeds high", () => {
    expect(EstimateSchema.safeParse({ ...estimate, lowUsd: 10, highUsd: 2 }).success).toBe(false);
  });

  it("formats a range with its basis", () => {
    const out = formatEstimate(estimate);
    expect(out).toContain("$3");
    expect(out).toContain("$6");
    expect(out).toContain("Single-purpose CLI");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/core/estimate.test.ts`
Expected: FAIL — cannot resolve `../../src/core/estimate.js`

- [ ] **Step 3: Write the implementation**

`src/core/estimate.ts`:

```typescript
import { z } from "zod";
import { artifactPath, type Env } from "./paths.js";
import { readRecords, appendRecord } from "./jsonl.js";

export const EstimateSchema = z
  .object({
    phase: z.enum(["front", "build"]),
    lowUsd: z.number().nonnegative(),
    highUsd: z.number().nonnegative(),
    basis: z.string().min(1),
    at: z.string(),
  })
  .refine((e) => e.lowUsd <= e.highUsd, { message: "lowUsd must not exceed highUsd" });

export type Estimate = z.infer<typeof EstimateSchema>;
export const ESTIMATE_FILE = "ESTIMATE.jsonl";

export function readEstimate(id: string, env?: Env): Estimate[] {
  return readRecords(artifactPath(id, ESTIMATE_FILE, env), EstimateSchema);
}

/** Appends: the rough and precise estimates are both worth keeping. */
export function writeEstimate(id: string, estimate: Estimate, env?: Env): void {
  appendRecord(artifactPath(id, ESTIMATE_FILE, env), EstimateSchema, estimate);
}

export function formatEstimate(e: Estimate): string {
  return `estimated ${e.phase}: $${e.lowUsd}–$${e.highUsd} — ${e.basis}`;
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run tests/core/estimate.test.ts`
Expected: PASS — 4 tests

- [ ] **Step 5: Extend the triage schema to return an estimate**

Triage already makes exactly one structured model call, so the estimate rides along rather than paying for a second invocation. In `src/stages/triage.ts`, add to `TriageResultSchema`:

```typescript
  estimateLowUsd: z.number().nonnegative(),
  estimateHighUsd: z.number().nonnegative(),
  estimateBasis: z.string(),
```

and append to the `SYSTEM` prompt:

```
Also estimate what the research + spec + clarify stages will cost, as a USD range.
For calibration: a single-purpose CLI with a handful of searches ran $3-6 end to end;
a broad idea needing extensive research could be several times that. Give the range
you actually believe, and state the basis in one sentence.
```

- [ ] **Step 6: Record and print it in `createProject`**

In `src/commands/new.ts`, after `writeState` and before `commitStage`:

```typescript
  writeEstimate(
    id,
    {
      phase: "front",
      lowUsd: verdict.estimateLowUsd,
      highUsd: verdict.estimateHighUsd,
      basis: verdict.estimateBasis,
      at: now,
    },
    env,
  );
```

and in the `new` action in `src/cli.ts`, print it after the captured line so the number is visible before any spend:

```typescript
      console.log(`captured: ${id}`);
      const { readEstimate, formatEstimate } = await import("./core/estimate.js");
      const estimates = readEstimate(id);
      if (estimates[0]) console.log(formatEstimate(estimates[0]));
```

- [ ] **Step 7: Verify and commit**

Run: `npm test && npm run build && npm run typecheck`

```bash
git add -A && git commit -m "feat: rough cost estimate at capture, riding the existing triage call"
```

---

## Task 9: Per-archetype gitignore seeding

**Files:**
- Create: `src/core/archetype.ts`
- Modify: `src/commands/new.ts`
- Test: `tests/core/archetype.test.ts`

**Design note:** safe today only because stages emit markdown. Once Plan B's build stage runs, `git add -A` sweeps whatever the model created — `node_modules/`, `.venv/`, build output, a scratch file holding an API key. Seeding must land before the first build, not with it.

- [ ] **Step 1: Write the failing test**

`tests/core/archetype.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { gitignoreFor, ARCHETYPES } from "../../src/core/archetype.js";

describe("gitignoreFor", () => {
  it("always ignores the stage logs", () => {
    expect(gitignoreFor("cli-python")).toContain(".sfo/logs/");
    expect(gitignoreFor("unknown-archetype")).toContain(".sfo/logs/");
  });

  it("ignores Python build and env output for the python CLI archetype", () => {
    const body = gitignoreFor("cli-python");
    expect(body).toContain("__pycache__/");
    expect(body).toContain(".venv/");
  });

  it("ignores node output for the node CLI archetype", () => {
    expect(gitignoreFor("cli-node")).toContain("node_modules/");
  });

  it("falls back to a safe default for an unknown archetype rather than an empty file", () => {
    // An unknown archetype must not mean 'commit everything'.
    const body = gitignoreFor("something-nobody-registered");
    expect(body).toContain("node_modules/");
    expect(body).toContain(".venv/");
  });

  it("lists the archetypes it knows", () => {
    expect(Object.keys(ARCHETYPES)).toContain("cli-python");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/core/archetype.test.ts`
Expected: FAIL — cannot resolve `../../src/core/archetype.js`

- [ ] **Step 3: Write the implementation**

`src/core/archetype.ts`:

```typescript
/**
 * Ignore patterns per archetype. Plan B grows this into the full registry
 * (scaffold fragments and verify recipes); for now it exists so the ignores
 * are in place BEFORE the build stage writes code. Once `git add -A` runs over
 * a directory a model has been building in, whatever is not ignored is history.
 */
const COMMON = [".sfo/logs/", ".DS_Store", "*.log"];

const PYTHON = ["__pycache__/", "*.py[cod]", ".venv/", "venv/", ".pytest_cache/", ".mypy_cache/", ".ruff_cache/", "dist/", "build/", "*.egg-info/"];
const NODE = ["node_modules/", "dist/", "build/", ".turbo/", "*.tsbuildinfo"];

export const ARCHETYPES: Record<string, string[]> = {
  "cli-python": PYTHON,
  "cli-node": NODE,
};

/**
 * An unknown archetype gets the union, not an empty file. Being over-broad
 * costs an ignored file nobody wanted ignored; being under-broad commits a
 * virtualenv, or a scratch file holding a key.
 */
const FALLBACK = [...new Set([...PYTHON, ...NODE])];

export function gitignoreFor(archetype: string): string {
  const specific = ARCHETYPES[archetype] ?? FALLBACK;
  const header = `# generated by sfo for archetype: ${archetype}`;
  return `${[header, ...COMMON, ...specific].join("\n")}\n`;
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run tests/core/archetype.test.ts`
Expected: PASS — 5 tests

- [ ] **Step 5: Use it in `createProject`**

In `src/commands/new.ts`, replace the current `.gitignore` write with `gitignoreFor`. The archetype is unknown at capture — the spec stage picks it — so pass the fallback explicitly:

```typescript
  // Archetype is not known until the spec stage runs, so seed the union. The
  // spec stage rewrites this once it has chosen.
  fs.writeFileSync(path.join(dir, ".gitignore"), gitignoreFor("unknown"));
```

- [ ] **Step 6: Have the spec stage narrow it**

Append to `src/stages/prompts/spec.md`:

```markdown
Once you have chosen the stack, rewrite the project's root `.gitignore` for it —
dependency directories, build output, caches, virtual environments, and anything
else a build would generate. Keep the existing `.sfo/logs/` line. The build stage
commits with `git add -A`, so anything missing from this file ends up in history
permanently.
```

- [ ] **Step 7: Verify and commit**

Run: `npm test && npm run build && npm run typecheck`

```bash
git add -A && git commit -m "feat: seed per-archetype gitignores before the build stage exists"
```

---

## Task 10: Fast clarify loop

**Files:**
- Create: `src/core/openQuestions.ts`
- Modify: `src/core/orchestrator.ts`, `src/cli.ts`
- Test: `tests/core/openQuestions.test.ts`, update `tests/core/orchestrator.test.ts`

**Design note:** the founding constraint — never block, because every round trip costs hours — applies to the async boundary. It does not apply to a person already at the keyboard. When clarify raises new blocking questions, say so immediately rather than parking silently for hours.

Detection is by **id set difference**, not file timestamps. A question whose id has no answer is unanswered; that is deterministic, survives a file being rewritten, and does not depend on filesystem mtime resolution.

- [ ] **Step 1: Write the failing test**

`tests/core/openQuestions.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openQuestions } from "../../src/core/openQuestions.js";
import { writeQuestions, writeAnswers } from "../../src/core/questions.js";

let env: Record<string, string>;

function q(id: string) {
  return {
    id,
    section: "blocking" as const,
    text: `question ${id}`,
    context: "",
    options: [
      { key: "A", label: "a", tradeoff: "" },
      { key: "B", label: "b", tradeoff: "" },
    ],
  };
}

beforeEach(() => {
  env = { SFO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sfo-oq-")) };
  fs.mkdirSync(path.join(env.SFO_HOME, "p", ".sfo"), { recursive: true });
});

describe("openQuestions", () => {
  it("returns every question when nothing has been answered", () => {
    writeQuestions("p", { questions: [q("Q-001"), q("Q-002")] }, env);
    expect(openQuestions("p", env).map((x) => x.id)).toEqual(["Q-001", "Q-002"]);
  });

  it("returns nothing when every question has an answer", () => {
    writeQuestions("p", { questions: [q("Q-001")] }, env);
    writeAnswers("p", { answers: [{ questionId: "Q-001", answer: "A" }] }, env);
    expect(openQuestions("p", env)).toEqual([]);
  });

  it("returns only the questions clarify added after the last answers", () => {
    // The fast-loop case: clarify folded in the answers and asked something new.
    writeQuestions("p", { questions: [q("Q-001")] }, env);
    writeAnswers("p", { answers: [{ questionId: "Q-001", answer: "A" }] }, env);
    writeQuestions("p", { questions: [q("Q-001"), q("Q-002")] }, env);

    expect(openQuestions("p", env).map((x) => x.id)).toEqual(["Q-002"]);
  });

  it("treats a blank answer as answered — the human chose to skip it", () => {
    writeQuestions("p", { questions: [q("Q-001")] }, env);
    writeAnswers("p", { answers: [{ questionId: "Q-001", answer: "" }] }, env);
    expect(openQuestions("p", env)).toEqual([]);
  });

  it("returns nothing when no questions exist at all", () => {
    expect(openQuestions("p", env)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/core/openQuestions.test.ts`
Expected: FAIL — cannot resolve `../../src/core/openQuestions.js`

- [ ] **Step 3: Write the implementation**

`src/core/openQuestions.ts`:

```typescript
import { readQuestions, readAnswers } from "./questions.js";
import type { Env } from "./paths.js";
import type { z } from "zod";
import type { QuestionSchema } from "./questions.js";

type Question = z.infer<typeof QuestionSchema>;

/**
 * Questions with no corresponding answer, by id.
 *
 * Deliberately not an mtime comparison between QUESTIONS.json and
 * ANSWERS.json: a stage that rewrites a file without changing its content
 * would look like new questions, and filesystem timestamp resolution is
 * coarse enough that two writes in the same second are indistinguishable.
 * An id with no answer is unambiguous.
 */
export function openQuestions(id: string, env?: Env): Question[] {
  const questions = readQuestions(id, env);
  if (!questions) return [];

  const answered = new Set((readAnswers(id, env)?.answers ?? []).map((a) => a.questionId));
  return questions.questions.filter((q) => !answered.has(q.id));
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run tests/core/openQuestions.test.ts`
Expected: PASS — 5 tests

- [ ] **Step 5: Point the human gate at the JSON filename**

In `src/core/orchestrator.ts`:

```typescript
const HUMAN_INPUT: Record<string, string> = { clarify: "ANSWERS.json" };
```

- [ ] **Step 6: Tell the user immediately when questions remain**

In `src/cli.ts`'s `run` action, after `runAttached` resolves, report open questions rather than leaving the user to discover them via `sfo status`:

```typescript
      if (opts.attach) {
        await runAttached(id);
        const { openQuestions } = await import("./core/openQuestions.js");
        const open = openQuestions(id);
        if (open.length > 0) {
          console.log(
            `
sfo: ${open.length} question(s) still open — run \`sfo answer ${id}\``,
          );
        }
      }
```

Keep this in the command layer: the orchestrator returns state, the CLI decides what to say about it.

- [ ] **Step 7: Have `sfo answer` ask only what is open**

In `src/commands/answer.ts`, replace `questions.questions` with `openQuestions(id, env)` as the loop source, and **merge** into any existing answers rather than overwriting — a second pass must not erase the first pass's answers.

```typescript
  const open = openQuestions(id, env);
  if (open.length === 0) {
    throw new Error(`no open questions for ${id}`);
  }

  // ... prompt loop over `open` ...

  const existing = readAnswers(id, env)?.answers ?? [];
  writeAnswers(id, { answers: [...existing, ...answers] }, env);
```

Add a test asserting a second `promptForAnswers` pass preserves the first pass's answers.

- [ ] **Step 8: Verify and commit**

Run: `npm test && npm run build && npm run typecheck`

```bash
git add -A && git commit -m "feat: detect open questions by id, enabling a fast clarify loop"
```

---

## Task 11: Regenerate the existing project's artifacts

**Files:**
- Modify: none — this is a verification task against real data.

The screenshot renamer's artifacts are in the old markdown formats. Rather than writing a migration for a format nobody else has, re-run the two stages that produce them. `SPEC.md` prose is regenerated, which is acceptable — the human answers survive in `ANSWERS.md` and get re-folded.

- [ ] **Step 1: Back up the existing artifacts**

```bash
cp -r ~/.sfo/screenshot-content-renamer-fee869 /tmp/sfo-backup-$(date +%s)
```

- [ ] **Step 2: Convert the answers to the new format by hand**

`ANSWERS.md` has nine answers keyed by question text. Write `~/.sfo/screenshot-content-renamer-fee869/.sfo/ANSWERS.json` mapping them to `Q-001`…`Q-009` in the same order they appear, preserving the free text on the last one verbatim (`"a, but can use a flag to materialize cloud fiels"`). Then delete `ANSWERS.md`.

- [ ] **Step 3: Re-run spec and clarify**

```bash
export SFO_MAX_BUDGET_USD=10
node dist/cli.js stage screenshot-content-renamer-fee869 spec
node dist/cli.js stage screenshot-content-renamer-fee869 clarify
```

Expected: ~$2 total, and `.sfo/` now contains `CRITERIA.jsonl`, `QUESTIONS.json`, `DECISIONS.jsonl`, and no `QUESTIONS.md` / `DECISIONS.md`.

- [ ] **Step 4: Verify the new artifacts load**

```bash
node dist/cli.js criteria screenshot-content-renamer-fee869
node dist/cli.js decisions screenshot-content-renamer-fee869
```

Expected: criteria grouped with a count; decisions with structural ones first. **If either throws a schema error, the prompt is wrong** — fix the prompt and re-run the stage rather than hand-editing the file, or the next project reproduces the bug.

- [ ] **Step 5: Record the outcome**

Append to `docs/RUNBOOK.md`: the criterion count in the new format (was 43 in markdown), whether the grouping survived, the regeneration cost, and any schema violations the prompts produced on first attempt. That last one is the real signal — it tells you whether the format is one a model reliably emits.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "docs: record the artifact format migration"
```

---

## Definition of done for Plan A

- [ ] `npm test` green, `npm run build` and `npm run typecheck` clean
- [ ] `sfo criteria` and `sfo decisions` render the regenerated project
- [ ] The spec stage emits all three structured files without schema violations
- [ ] `parseQuestions` and its regex are deleted, not deprecated
- [ ] A `no_gap` prior-art verdict stops the pipeline before the spec stage
- [ ] `sfo new` prints a cost range before any research spend
- [ ] A fresh project's `.gitignore` covers Python and Node build output

## Explicitly deferred to Plan B

`plan` slicing and the `slice` field · precise post-plan estimate · per-project budget ceiling and the pause-on-hit path · `test-write` · `test-repair` and test hashing · sliced `build`/`verify` · `review` · `deliver` and `SUMMARY.md` · the `cli` archetype's scaffold and verify recipes.
