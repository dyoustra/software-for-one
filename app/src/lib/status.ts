import type { ProjectSummary } from '@sfo/api';

/** What a project's state means to the person, in the words `sfo status` uses. */
export function statusLabel(summary: ProjectSummary | null): { text: string; tone: 'active' | 'needs' | 'done' | 'bad' } {
  if (!summary) return { text: 'setting up', tone: 'active' };
  switch (summary.status) {
    case 'running':
      return { text: `${summary.currentStage}…`, tone: 'active' };
    case 'awaiting_human':
      return { text: summary.currentStage === 'clarify' ? 'has questions for you' : 'needs you', tone: 'needs' };
    case 'failed':
      return { text: `failed at ${summary.currentStage}`, tone: 'bad' };
    case 'done':
      return { text: 'done', tone: 'done' };
    default:
      return { text: summary.status, tone: 'active' };
  }
}
