import readline from "node:readline/promises";
import { readQuestions, readAnswers, writeAnswers } from "../core/questions.js";
import { openQuestions } from "../core/openQuestions.js";
import { readState, writeState } from "../core/state.js";
import { spawnSync } from "node:child_process";
import { draftImages } from "../core/presentation.js";
import type { Env } from "../core/paths.js";

export type Ask = (prompt: string) => Promise<string>;

type Reader = { ask: Ask; close: () => void };

function stdinReader(): Reader {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return { ask: (prompt) => rl.question(prompt), close: () => rl.close() };
}

type Answer = { questionId: string; answer: string; questionText: string };

/** The questions still waiting for the person, or why there are none to answer. */
function openFor(id: string, env?: Env): ReturnType<typeof openQuestions> {
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
  return open;
}

function saveAnswers(id: string, answers: Answer[], env?: Env): string {
  // Merge, never replace: writeAnswers overwrites the file, so a second pass
  // answering two follow-ups would otherwise erase the first pass's answers.
  const existing = readAnswers(id, env)?.answers ?? [];
  writeAnswers(id, { answers: [...existing, ...answers] }, env);

  const state = readState(id, env);
  writeState({ ...state, status: "awaiting_human", updatedAt: new Date().toISOString() }, env);
  return `answers saved — run \`sfo run ${id}\` to fold them into the spec`;
}

/**
 * Answers given all at once, keyed by question id: for anything answering
 * without a terminal, such as the app. Every open question must be answered,
 * and only those, or nothing is saved.
 */
export function answerFrom(id: string, given: Record<string, string>, env?: Env): string {
  const open = openFor(id, env);
  const unknown = Object.keys(given).filter((qid) => !open.some((q) => q.id === qid));
  if (unknown.length > 0) throw new Error(`not open questions for ${id}: ${unknown.join(", ")}`);
  const missing = open.filter((q) => !given[q.id]?.trim()).map((q) => q.id);
  if (missing.length > 0) throw new Error(`no answer given for ${missing.join(", ")}`);
  return saveAnswers(
    id,
    open.map((q) => ({ questionId: q.id, answer: given[q.id].trim(), questionText: q.text })),
    env,
  );
}

export async function promptForAnswers(id: string, env?: Env, ask?: Ask): Promise<void> {
  const open = openFor(id, env);

  // Drafts are pictures: a question asking which looks right is unanswerable
  // from the option labels alone.
  const drafts = draftImages(id, env);
  if (drafts.length > 0) {
    console.log("\nDrafts to choose from (light and dark background):");
    for (const d of drafts) console.log(`  ${d}`);
    if (!ask && process.platform === "darwin") spawnSync("open", drafts, { stdio: "ignore" });
  }

  const reader = ask ? { ask, close: () => {} } : stdinReader();
  const answers: Answer[] = [];

  try {
    for (const q of open) {
      console.log(`\n[${q.section}] ${q.text}`);
      if (q.context) console.log(`  ${q.context}`);
      for (const o of q.options) console.log(`  ${o.key} — ${o.label} — ${o.tradeoff}`);
      answers.push({
        questionId: q.id,
        answer: await reader.ask("> "),
        // Recorded so a later stage reusing this id cannot inherit the answer.
        questionText: q.text,
      });
    }
  } finally {
    reader.close();
  }

  console.log(`\n${saveAnswers(id, answers, env)}`);
}
