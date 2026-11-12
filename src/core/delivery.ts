import fs from "node:fs";
import { z } from "zod";
import { artifactPath, type Env } from "./paths.js";

/**
 * What a finished project is and how to use it, in a shape an app can render
 * (RESULTS_SPEC §3). Written by the deliver stage beside SUMMARY.md; only the
 * parts that need judgment: cost, time, slices and installed commands come
 * from sfo's own records.
 */
export const DeliverySchema = z.object({
  what: z.string().min(1).max(200),
  use: z
    .array(
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("command"), command: z.string().min(1).max(300), label: z.string().max(80).optional() }),
        // Only web addresses: the app opens this, and a model wrote it.
        z.object({ kind: z.literal("url"), url: z.string().url().max(500).refine(isWebAddress, "url must be http(s)"), label: z.string().max(80).optional() }),
        z.object({ kind: z.literal("step"), text: z.string().min(1).max(300) }),
      ]),
    )
    .min(1)
    .max(6),
  examples: z.array(z.object({ say: z.string().min(1).max(120), do: z.string().min(1).max(300) })).max(4),
  features: z.array(z.string().min(1).max(140)).min(1).max(6),
  gaps: z.array(z.object({ text: z.string().min(1).max(200), weight: z.enum(["blocks", "limits", "note"]) })).max(6),
});

export type Delivery = z.infer<typeof DeliverySchema>;

export function isWebAddress(url: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

export const DELIVERY_FILE = "DELIVERY.json";

/** The file's problem, in words a retry can act on, or null when it is right. */
export function deliveryProblem(raw: string | null): string | null {
  if (raw === null) return `the deliver stage did not write .sfo/${DELIVERY_FILE}`;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return `.sfo/${DELIVERY_FILE} is not JSON`;
  }
  const parsed = DeliverySchema.safeParse(value);
  if (parsed.success) return null;
  const issue = parsed.error.issues[0];
  return `.sfo/${DELIVERY_FILE} does not match its schema: ${issue.path.join(".") || "(top)"} — ${issue.message}`;
}

/**
 * The file as written, or null. Only a regular file: an agent could leave a
 * symlink there, and sfo, unlike the agent, is not sandboxed.
 */
export function readDeliveryFile(id: string, env?: Env): string | null {
  const file = artifactPath(id, DELIVERY_FILE, env);
  try {
    if (!fs.lstatSync(file).isFile()) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** The delivery, when there is a valid one. */
export function parseDelivery(raw: string | null): Delivery | null {
  if (raw === null || deliveryProblem(raw)) return null;
  return DeliverySchema.parse(JSON.parse(raw));
}
