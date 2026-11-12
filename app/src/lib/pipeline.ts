import type { Project, ProjectSummary } from '@sfo/api';

type Tone = 'running' | 'waiting' | 'done' | 'failed';

/** The seven milestones a card's rail shows (THEME_SPEC §6). */
export const MILESTONES = ['Research', 'Spec', 'Clarify', 'Plan', 'Build', 'Verify', 'Deliver'] as const;
export type Milestone = (typeof MILESTONES)[number];

/** Pipeline stages, collapsed into the milestone each belongs to. */
const STAGE_MILESTONE: Record<string, Milestone> = {
  capture: 'Research',
  research: 'Research',
  spec: 'Spec',
  clarify: 'Clarify',
  plan: 'Plan',
  'test-write': 'Plan',
  'test-repair': 'Plan',
  build: 'Build',
  smoke: 'Verify',
  review: 'Verify',
  deliver: 'Deliver',
};

/** Where a stage sits on the rail; a stage this app does not know sits at the start. */
export function milestoneIndex(stage: string): number {
  return Math.max(0, MILESTONES.indexOf(STAGE_MILESTONE[stage] ?? 'Research'));
}

const RUNNING_WORDS: Record<Milestone, string> = {
  Research: 'Researching',
  Spec: 'Writing the spec',
  Clarify: 'Clarifying',
  Plan: 'Planning',
  Build: 'Building',
  Verify: 'Verifying',
  Deliver: 'Delivering',
};

export type CardKind = 'setup' | 'waiting' | 'running' | 'failed' | 'done';

/** Everything a project card shows, decided once, so every screen shows a project the same way. */
export interface CardModel {
  kind: CardKind;
  title: string;
  badge: { tone: Tone; text: string };
  /** The rail, for runs in progress: where it is, and how its node looks. Absent for finished runs. */
  rail?: { at: number; tone: Tone; halo: 'breathing' | 'steady' | 'none' };
  /** Slice dots and count, once the run has a plan. */
  slices?: { passed: number; failed: number; total: number };
  spend?: string;
  /** Model time, or `Parked` while the run waits on the person. */
  time?: string;
  /** One line of words for the footer: a setup step, why a run failed, or what a finished run delivered. */
  line?: string;
  /** True when that line is a command or name to be read as machine text. */
  lineIsCode?: boolean;
}

export function formatSpend(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function slicesOf(s: ProjectSummary): CardModel['slices'] {
  return s.slicesTotal ? { passed: s.slicesPassed?.length ?? 0, failed: s.slicesFailed?.length ?? 0, total: s.slicesTotal } : undefined;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function cardModel(project: Project): CardModel {
  const s = project.summary;
  if (project.status === 'creating' || !s) {
    const error = project.setup?.error;
    const title = project.idea ? firstLine(project.idea) : 'New project';
    return error
      ? { kind: 'failed', title, badge: { tone: 'failed', text: 'Setup failed' }, line: error }
      : { kind: 'setup', title, badge: { tone: 'running', text: 'Setting up' }, rail: { at: -1, tone: 'running', halo: 'none' }, line: project.setup?.step ?? 'Setting up its machine' };
  }

  const at = milestoneIndex(s.currentStage);
  const spend = s.spendUsd !== undefined ? formatSpend(s.spendUsd) : undefined;
  const time = s.computeMs ? formatDuration(s.computeMs) : undefined;
  const base = { title: s.title, slices: slicesOf(s), spend };

  switch (s.status) {
    case 'awaiting_human': {
      const text = s.openQuestions ? plural(s.openQuestions, 'question') : s.currentStage === 'clarify' ? 'Questions' : 'Needs you';
      // Without questions, the note is what it waits for: a budget, a crash, a stop, prior art.
      return { ...base, kind: 'waiting', badge: { tone: 'waiting', text }, rail: { at, tone: 'waiting', halo: 'steady' }, time: 'Parked', line: s.openQuestions ? undefined : s.note };
    }
    case 'running':
      return { ...base, kind: 'running', badge: { tone: 'running', text: RUNNING_WORDS[MILESTONES[at]] }, rail: { at, tone: 'running', halo: 'breathing' }, time };
    case 'failed':
      return {
        ...base,
        kind: 'failed',
        badge: { tone: 'failed', text: `Failed at ${MILESTONES[s.failure ? milestoneIndex(s.failure.stage) : at]}` },
        rail: { at: s.failure ? milestoneIndex(s.failure.stage) : at, tone: 'failed', halo: 'none' },
        slices: undefined,
        line: s.failure?.reason ?? s.note,
        time,
      };
    case 'done': {
      const commands = s.delivered?.commands ?? [];
      // A `done` with a note has something unresolved (smoke, review, deferred checks).
      const badge: CardModel['badge'] = s.note ? { tone: 'waiting', text: 'Done, with notes' } : { tone: 'done', text: commands.length ? '✓ CLI' : '✓ Done' };
      // What you got: the commands it installed, else what is unresolved, else its repo.
      const line = commands.length ? commands.join('  ') : (s.note ?? (project.repo ? project.repo.replace(/^https?:\/\//, '').replace(/^github\.com\//, '') : undefined));
      return { ...base, kind: 'done', badge, time, line, lineIsCode: commands.length > 0 || (!s.note && !!project.repo) };
    }
    default:
      return { ...base, kind: 'running', badge: { tone: 'running', text: s.status }, rail: { at, tone: 'running', halo: 'none' }, time };
  }
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0];
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

/** Projects in the order that needs the person most: waiting, setting up, running, failed, then done; newest change first within each. */
export function byAttention(projects: Project[]): Project[] {
  const rank: Record<CardKind, number> = { waiting: 0, setup: 1, running: 2, failed: 3, done: 4 };
  return [...projects].sort((a, b) => rank[cardModel(a).kind] - rank[cardModel(b).kind] || b.updatedAt.localeCompare(a.updatedAt));
}

/** Runs waiting on the person, the one waiting longest first. */
export function waitingOnYou(projects: Project[]): Project[] {
  return projects.filter((p) => cardModel(p).kind === 'waiting').sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
}
