import fs from "node:fs";
import path from "node:path";
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

/**
 * The answer is the raw string the human typed, never coerced to an option key
 * and never validated against the options offered. "A, but only with a
 * --materialize flag" is the answer that carries the requirement; narrowing the
 * type here would throw that away and leave the clarify stage with "A".
 */
export const AnswersSchema = z.object({
  answers: z.array(z.object({ questionId: z.string().min(1), answer: z.string() })),
});

export type Questions = z.infer<typeof QuestionsSchema>;
export type Answers = z.infer<typeof AnswersSchema>;

export const QUESTIONS_FILE = "QUESTIONS.json";
export const ANSWERS_FILE = "ANSWERS.json";

function readJson<T>(file: string, schema: z.ZodType<T>, label: string): T | null {
  if (!fs.existsSync(file)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${path.basename(file)} is not valid JSON`);
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error(`invalid ${label}: ${parsed.error.message}`);
  return parsed.data;
}

function writeJson<T>(file: string, schema: z.ZodType<T>, value: T, label: string): void {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`invalid ${label}: ${parsed.error.message}`);
  // Temp-file-and-rename, matching writeState. A crash mid-write would
  // otherwise leave a truncated file — and for ANSWERS.json that is answers a
  // person sat and typed, which no re-run can recover.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(parsed.data, null, 2)}\n`);
  fs.renameSync(tmp, file);
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
