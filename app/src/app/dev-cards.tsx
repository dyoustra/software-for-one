import type { Project, ProjectSummary } from '@sfo/api';
import { ProjectCard } from '@/components/project-card';
import { Heading, Page } from '@/components/ui';

const at = (summary: Partial<ProjectSummary> | null, extra: Partial<Project> = {}): Project => ({
  id: `${summary?.title ?? 'setup'}-000000`,
  sprite: 'sfo-00000000',
  repo: null,
  status: 'ready',
  summary: summary ? { id: 'x', title: 'Project', currentStage: 'spec', status: 'running', ...summary } : null,
  createdAt: '2026-11-11T00:00:00Z',
  updatedAt: '2026-11-11T00:00:00Z',
  ...extra,
});

const SAMPLES: Project[] = [
  at({ title: 'shotname', status: 'awaiting_human', currentStage: 'clarify', openQuestions: 2, spendUsd: 0.18 }),
  at(null, { status: 'creating', idea: 'A CLI that tells me if the moon is up tonight', setup: { step: 'Reading your idea', error: null } }),
  at({ title: 'downloads-triage', status: 'running', currentStage: 'build', slicesTotal: 5, slicesPassed: ['S-01', 'S-02', 'S-03'], spendUsd: 1.4, computeMs: 14 * 60_000 }),
  at({ title: 'lattice', status: 'running', currentStage: 'research', spendUsd: 0.06, computeMs: 70_000 }),
  at({ title: 'autotune', status: 'failed', currentStage: 'review', failure: { stage: 'review', reason: 'Two review findings were left open after three attempts.' }, spendUsd: 2.31, computeMs: 31 * 60_000 }),
  at({ title: 'tax-sorter', status: 'done', currentStage: 'deliver', delivered: { commands: ['tax-sorter'] }, slicesTotal: 4, slicesPassed: ['a', 'b', 'c', 'd'], spendUsd: 0.92, computeMs: 11 * 60_000 }),
  at({ title: 'kotor-pazaak', status: 'done', currentStage: 'deliver', note: 'done, but smoke found 1 problem', slicesTotal: 6, slicesPassed: ['a', 'b', 'c', 'd', 'e', 'f'], spendUsd: 1.84, computeMs: 22 * 60_000 }),
];

/** Every card state at once, for checking the design. Development builds only. */
export default function DevCards() {
  if (!__DEV__) return null;
  return (
    <Page>
      <Heading>Cards</Heading>
      {SAMPLES.map((p) => (
        <ProjectCard key={p.id} project={p} />
      ))}
    </Page>
  );
}
