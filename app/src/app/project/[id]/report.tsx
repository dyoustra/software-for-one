import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';

import type { Report } from '@sfo/api';
import { Code, ErrorText, Muted, Page } from '@/components/ui';
import { useAuth } from '@/lib/auth';

const TITLES: Record<string, string> = { summary: 'Summary', cost: 'Cost', decisions: 'Decisions', criteria: 'Criteria', slices: 'Slices', logs: 'Current log' };

export default function ReportScreen() {
  const { id, kind } = useLocalSearchParams<{ id: string; kind: string }>();
  const { api } = useAuth();
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api<Report>(kind === 'summary' ? `/projects/${id}/summary` : `/projects/${id}/report/${kind}`).then(setReport, setError);
  }, [api, id, kind]);

  return (
    <Page>
      <Stack.Screen options={{ title: TITLES[kind] ?? 'Report' }} />
      <ErrorText error={error} />
      {report && (report.output.trim() ? <Code>{report.output.trim()}</Code> : <Muted>Nothing yet.</Muted>)}
    </Page>
  );
}
