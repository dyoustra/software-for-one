import readline from "node:readline/promises";
import { readQuestions, readAnswers, writeAnswers } from "../core/questions.js";
import { openQuestions } from "../core/openQuestions.js";
import { readState, writeState } from "../core/state.js";
import type { Env } from "../core/paths.js";

export type Ask = (prompt: string) => Promise<string>;

type Reader = { ask: Ask; close: () => void };

function stdinReader(): Reader {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return { ask: (prompt) => rl.question(prompt), close: () => rl.close() };
}

export async function promptForAnswers(id: string, env?: Env, ask?: Ask): Promise<void> {
  // Existence check only — a typo'd id must report "no such project", not
  // blame a missing QUESTIONS.json. The state written at the end is re-read
  // there, because the human may sit at the prompt for a long time.
  readState(id, env);

  const questions = readQuestions(id, env);
  if (!questions) {
    throw new Error(`no QUESTIONS.json for ${id} — has the spec stage run?`);
  }
  if (questions.questions.length === 0) {
    // A schema-valid file can still hold an empty list. Without this guard we'd
    // prompt for nothing, write an empty ANSWERS.json, print "answers saved",
    // and unblock the pipeline — a confident success for an empty handoff.
    throw new Error(
      `QUESTIONS.json for ${id} contains no questions — re-run the stage with \`sfo stage ${id} spec\``,
    );
  }

  const open = openQuestions(id, env);
  if (open.length === 0) {
    throw new Error(`no open questions for ${id}`);
  }

  const reader = ask ? { ask, close: () => {} } : stdinReader();
  const answers: { questionId: string; answer: string }[] = [];

  try {
    for (const q of open) {
      console.log(`\n[${q.section}] ${q.text}`);
      if (q.context) console.log(`  ${q.context}`);
      for (const o of q.options) console.log(`  ${o.key} — ${o.label} — ${o.tradeoff}`);
      answers.push({ questionId: q.id, answer: await reader.ask("> ") });
    }
  } finally {
    reader.close();
  }

  // Merge, never replace: writeAnswers overwrites the file, so a second pass
  // answering two follow-ups would otherwise erase the first pass's answers.
  const existing = readAnswers(id, env)?.answers ?? [];
  writeAnswers(id, { answers: [...existing, ...answers] }, env);

  const state = readState(id, env);
  writeState({ ...state, status: "awaiting_human", updatedAt: new Date().toISOString() }, env);
  console.log(`\nanswers saved — run \`sfo run ${id}\` to fold them into the spec`);
}
