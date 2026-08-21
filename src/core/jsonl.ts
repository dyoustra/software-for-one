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
