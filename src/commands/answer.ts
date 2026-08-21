import readline from "node:readline/promises";
import { readArtifact, writeArtifact } from "../core/artifacts.js";
import { readState, writeState } from "../core/state.js";
import type { Env } from "../core/paths.js";

export interface Question {
  section: string;
  text: string;
  options: string[];
}

/**
 * QUESTIONS.md is the wire format, not a transport for one. Parsing the
 * markdown the agent already wrote keeps the human's turn deterministic and
 * free, where a second model call would be neither — and the same file can be
 * rendered as a UI later without touching this.
 */
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
  // Existence check only — a typo'd id must report "no such project", not
  // blame a missing QUESTIONS.md. The state written at the end is re-read
  // there, because the human may sit at the prompt for a long time.
  readState(id, env);

  const raw = readArtifact(id, "QUESTIONS.md", env);
  if (!raw) throw new Error(`no QUESTIONS.md for ${id} — has the spec stage run?`);

  const questions = parseQuestions(raw);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answers: string[] = [];

  try {
    for (const q of questions) {
      console.log(`\n[${q.section}] ${q.text}`);
      q.options.forEach((o) => console.log(`  ${o}`));
      answers.push(await rl.question("> "));
    }
  } finally {
    rl.close();
  }

  writeArtifact(id, "ANSWERS.md", renderAnswers(questions, answers), env);

  const state = readState(id, env);
  writeState({ ...state, status: "awaiting_human", updatedAt: new Date().toISOString() }, env);
  console.log(`\nanswers saved — run \`sfo run ${id}\` to fold them into the spec`);
}
