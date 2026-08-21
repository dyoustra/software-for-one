import { readQuestions, readAnswers, type Question } from "./questions.js";
import type { Env } from "./paths.js";

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
