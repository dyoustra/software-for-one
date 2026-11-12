import type { ProjectResults } from "../api/types.js";
import type { Env } from "./paths.js";
import { readState } from "./state.js";
import { parseDelivery, readDeliveryFile } from "./delivery.js";
import { installedCommands, readInstall } from "./install.js";
import { readCriteria } from "./criteria.js";
import { readCostRecords } from "./cost.js";
import { readSlices, skippedBy } from "./slices.js";
import { readVerifyRecords } from "./verifyRecord.js";
import { readPriorArt } from "./priorart.js";

function quietly<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/**
 * What a project produced, in the shape the app's done, Cost and Slices
 * screens show (RESULTS_SPEC §4), read with sfo's own record readers. Any
 * record missing or unreadable leaves its part empty rather than failing the
 * rest.
 */
export function resultsFor(id: string, env?: Env): ProjectResults {
  const state = quietly(() => readState(id, env), null);

  const criteria = quietly(() => readCriteria(id, env), []);
  const groups = [...new Set(criteria.map((c) => c.group))];

  const byStage = new Map<string, ProjectResults["cost"]["byStage"][number]>();
  for (const r of quietly(() => readCostRecords(id, env), [])) {
    const seen = byStage.get(r.stage) ?? { stage: r.stage, costUsd: 0, computeMs: 0, ok: r.ok, billing: r.billing ?? null };
    seen.costUsd += r.usage.costUsd;
    seen.computeMs += r.usage.durationMs;
    seen.ok = r.ok;
    seen.billing = r.billing ?? seen.billing;
    byStage.set(r.stage, seen);
  }
  const stages = [...byStage.values()].map((s) => ({ ...s, costUsd: Math.round(s.costUsd * 100) / 100 }));

  const slices = quietly(() => readSlices(id, env), []);
  const verify = quietly(() => readVerifyRecords(id, env), []);
  const passed = state?.slicesPassed ?? [];
  const failed = state?.slicesFailed ?? [];
  const skipped = new Set(skippedBy(slices, failed));

  return {
    priorArt: quietly(() => readPriorArt(id, env), null),
    delivery: parseDelivery(readDeliveryFile(id, env)),
    installed: installedCommands(quietly(() => readInstall(id, env), null)),
    featuresFallback: groups,
    cost: {
      totalUsd: Math.round(stages.reduce((n, s) => n + s.costUsd, 0) * 100) / 100,
      computeMs: stages.reduce((n, s) => n + s.computeMs, 0),
      byStage: stages,
    },
    slices: slices.map((s) => ({
      id: s.id,
      name: s.name,
      criteria: s.criterionIds,
      attempts: verify.filter((v) => v.slice === s.id && v.trigger === undefined).length,
      result: passed.includes(s.id) ? "passed" : failed.includes(s.id) ? "failed" : skipped.has(s.id) ? "skipped" : "pending",
    })),
  };
}
