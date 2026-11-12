import type { LogEvent } from '@sfo/api';

type ActionKind = 'read' | 'edit' | 'write' | 'run' | 'search' | 'fetch' | 'find' | 'tool';

/** One row of the activity list (LIVE_LOGS_SPEC §3). */
export type Row =
  | { key: string; kind: 'divider'; text: string; failed?: boolean }
  | { key: string; kind: 'action'; action: ActionKind; verb: string; target: string; status?: 'ok' | 'failed'; error?: string }
  | { key: string; kind: 'group'; action: ActionKind; verb: string; targets: string[]; failed: boolean }
  | { key: string; kind: 'say'; text: string }
  | { key: string; kind: 'alert'; tone: 'failed' | 'waiting'; text: string }
  | { key: string; kind: 'note'; text: string };

const VERBS: Record<ActionKind, string> = {
  read: 'Reading',
  edit: 'Editing',
  write: 'Writing',
  run: 'Running',
  search: 'Searching',
  fetch: 'Fetching',
  find: 'Finding',
  tool: 'Using',
};

/** What a collapsed run of one kind counts. */
const GROUP_NOUN: Partial<Record<ActionKind, [string, string]>> = { read: ['file', 'files'], find: ['pattern', 'patterns'], search: ['search', 'searches'] };

/** A command as worth reading: the agent prefixes most with `cd <project> &&`, which says nothing. */
export function shownCommand(command: string): string {
  return command.replace(/^cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*/, '');
}

function formatSeconds(ms: number): string {
  return ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`;
}

/**
 * Events as rows: a tool's result marks the row of its call (✓ or ✕, with the
 * error), consecutive reads, finds or searches collapse into one row, and a
 * stage's start and finish become dividers.
 */
export function toRows(events: LogEvent[]): Row[] {
  const results = new Map<string, { ok: boolean; text?: string }>();
  for (const e of events) if (e.kind === 'result' && e.id) results.set(e.id, { ok: e.ok, text: e.text });

  const rows: Row[] = [];
  events.forEach((e, i) => {
    const key = String(i);
    switch (e.kind) {
      case 'result':
        return;
      case 'start':
        rows.push({ key, kind: 'divider', text: `Started on ${e.text}` });
        return;
      case 'finish': {
        const parts = [e.ok ? 'Finished' : 'Stopped with an error'];
        if (e.costUsd !== undefined) parts.push(`$${e.costUsd.toFixed(2)}`);
        if (e.durationMs !== undefined) parts.push(formatSeconds(e.durationMs));
        rows.push({ key, kind: 'divider', text: parts.join('   '), failed: !e.ok });
        return;
      }
      case 'say':
        rows.push({ key, kind: 'say', text: e.text });
        return;
      case 'denied':
        rows.push({ key, kind: 'alert', tone: 'failed', text: `Not allowed: ${e.target}. ${e.text}` });
        return;
      case 'limit':
        rows.push(
          e.text.startsWith('allowed_warning')
            ? { key, kind: 'alert', tone: 'waiting', text: `Nearing a usage limit ${e.text.replace(/^allowed_warning\s*/, '')}` }
            : { key, kind: 'alert', tone: 'failed', text: `Usage limit reached ${e.text}` },
        );
        return;
      case 'note':
        rows.push({ key, kind: 'note', text: e.text });
        return;
      default: {
        const result = e.id ? results.get(e.id) : undefined;
        const failed = result?.ok === false;
        const prev = rows.at(-1);
        // A run of the same kind of looking-around folds into one row.
        if (GROUP_NOUN[e.kind] && !failed && prev && (prev.kind === 'group' || prev.kind === 'action') && prev.action === e.kind && (prev.kind === 'group' || prev.status !== 'failed')) {
          const targets = prev.kind === 'group' ? [...prev.targets, e.target] : [prev.target, e.target];
          rows[rows.length - 1] = { key: prev.key, kind: 'group', action: e.kind, verb: VERBS[e.kind], targets, failed: false };
          return;
        }
        rows.push({
          key,
          kind: 'action',
          action: e.kind,
          verb: e.kind === 'tool' ? `Using ${e.tool ?? 'a tool'}` : VERBS[e.kind],
          target: e.kind === 'tool' ? '' : e.kind === 'run' ? shownCommand(e.target) : e.target,
          ...(result ? { status: result.ok ? 'ok' : 'failed' } : {}),
          ...(result && !result.ok && result.text ? { error: result.text } : {}),
        });
      }
    }
  });
  return rows;
}

/** A group's summary: "4 files". */
export function groupCount(row: Extract<Row, { kind: 'group' }>): string {
  const [one, many] = GROUP_NOUN[row.action] ?? ['item', 'items'];
  return `${row.targets.length} ${row.targets.length === 1 ? one : many}`;
}

const STAGE_NAMES: Record<string, string> = {
  research: 'Research',
  spec: 'Spec',
  clarify: 'Clarify',
  plan: 'Plan',
  'test-write': 'Writing tests',
  'test-repair': 'Repairing tests',
  build: 'Build',
  smoke: 'Smoke check',
  review: 'Review',
  deliver: 'Deliver',
};

/** A stage log's name for people: `build-S-02` reads "Build · S-02". */
export function stageName(log: string): string {
  const slice = log.match(/^build-(S-\d+)$/);
  if (slice) return `Build · ${slice[1]}`;
  return STAGE_NAMES[log] ?? log.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
}
