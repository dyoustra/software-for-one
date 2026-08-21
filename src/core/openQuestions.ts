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

  // Keyed by id, but verified by text. An answer whose recorded text no longer
  // matches the question bearing that id means the id was reused for something
  // else — so the question counts as unanswered and gets asked again, rather
  // than silently inheriting an answer written against different wording.
  const answered = new Map(
    (readAnswers(id, env)?.answers ?? []).map((a) => [a.questionId, a.questionText]),
  );

  return questions.questions.filter((q) => {
    if (!answered.has(q.id)) return true;
    const answeredText = answered.get(q.id);
    // Answers written before questionText existed carry no text to verify.
    return answeredText !== undefined && answeredText !== q.text;
  });
}
