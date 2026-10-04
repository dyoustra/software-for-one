import { router, useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';

import type { Project } from '@sfo/api';
import { Body, Card, ErrorText, Heading, Muted, Page, Tone } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { statusLabel } from '@/lib/status';

/** How often to look again while something is running and the screen is open. */
const WHILE_RUNNING_MS = 30_000;

export default function Projects() {
  const { api } = useAuth();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const latest = useRef<Project[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    try {
      const fresh = await api<Project[]>('/projects');
      latest.current = fresh;
      setProjects(fresh);
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [api]);

  useFocusEffect(
    useCallback(() => {
      load();
      const timer = setInterval(() => {
        if (latest.current?.some((p) => p.summary?.status === 'running' || !p.summary)) load();
      }, WHILE_RUNNING_MS);
      return () => clearInterval(timer);
    }, [load]),
  );

  return (
    <Page
      refreshing={refreshing}
      onRefresh={async () => {
        setRefreshing(true);
        await load();
        setRefreshing(false);
      }}>
      <Heading>Projects</Heading>
      <ErrorText error={error} />
      {projects?.length === 0 && <Muted>Nothing yet. Start one from New idea.</Muted>}
      {projects?.map((p) => {
        const label = statusLabel(p.summary);
        return (
          <Card key={p.id} onPress={() => router.push({ pathname: '/project/[id]', params: { id: p.id } })}>
            <Body style={{ fontWeight: '600' }}>{p.summary?.title ?? p.id}</Body>
            <Tone tone={label.tone}>{label.text}</Tone>
            {p.summary?.note ? <Muted>{p.summary.note}</Muted> : null}
          </Card>
        );
      })}
    </Page>
  );
}
