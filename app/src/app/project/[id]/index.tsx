import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Alert, Linking, StyleSheet, TextInput, View } from 'react-native';

import type { Project, Question } from '@sfo/api';
import { Body, Button, Card, Code, ErrorText, Muted, Page, Tone } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useAuth } from '@/lib/auth';
import { statusLabel } from '@/lib/status';

const REPORTS = [
  { kind: 'summary', title: 'Summary' },
  { kind: 'cost', title: 'Cost' },
  { kind: 'decisions', title: 'Decisions' },
  { kind: 'criteria', title: 'Criteria' },
  { kind: 'slices', title: 'Slices' },
  { kind: 'logs', title: 'Current log' },
] as const;

export default function ProjectScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api } = useAuth();
  const theme = useTheme();
  const [project, setProject] = useState<Project | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const running = useRef(false);

  const load = useCallback(async () => {
    try {
      const p = await api<Project>(`/projects/${id}`);
      setProject(p);
      running.current = p.summary?.status === 'running';
      setQuestions(p.summary?.status === 'awaiting_human' ? await api<Question[]>(`/projects/${id}/questions`) : []);
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [api, id]);

  useFocusEffect(
    useCallback(() => {
      load();
      const timer = setInterval(() => running.current && load(), 20_000);
      return () => clearInterval(timer);
    }, [load]),
  );

  async function act(name: string, path: string, body?: unknown) {
    setBusy(name);
    setMessage(null);
    setError(null);
    try {
      const r = await api<{ message?: string }>(path, { method: 'POST', body });
      setMessage(r.message ?? null);
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  function destroy() {
    Alert.alert('Delete this project?', `Its machine and everything on it go${project?.repo ? '; its GitHub repo stays.' : ', and it has no repo: this is the only copy.'}`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await api(`/projects/${id}`, { method: 'DELETE' });
            router.back();
          } catch (err) {
            setError(err);
          }
        },
      },
    ]);
  }

  const summary = project?.summary ?? null;
  const label = statusLabel(summary);
  const status = summary?.status;
  return (
    <Page refreshing={false} onRefresh={load}>
      <Stack.Screen options={{ title: summary?.title ?? 'Project' }} />
      <ErrorText error={error} />
      {project && (
        <Card>
          <Tone tone={label.tone}>{label.text}</Tone>
          {summary?.note ? <Body>{summary.note}</Body> : null}
          {summary?.slicesPassed?.length ? <Muted>{summary.slicesPassed.length} slices passed</Muted> : null}
          {project.repo ? <Muted>{project.repo.replace('https://', '')}</Muted> : null}
          {project.repo ? <Button title="Open repo" kind="secondary" onPress={() => Linking.openURL(project.repo!)} /> : null}
        </Card>
      )}

      {questions.length > 0 && (
        <Button
          title={`Answer ${questions.length} question${questions.length === 1 ? '' : 's'}`}
          onPress={() => router.push({ pathname: '/project/[id]/questions', params: { id } })}
        />
      )}
      {status === 'running' && <Button title="Stop" kind="secondary" busy={busy === 'stop'} onPress={() => act('stop', `/projects/${id}/stop`)} />}
      {status === 'awaiting_human' && questions.length === 0 && (
        <Button title="Resume" busy={busy === 'run'} onPress={() => act('run', `/projects/${id}/run`)} />
      )}
      {(status === 'failed' || (status === 'done' && /fail|unresolved/.test(summary?.note ?? ''))) && (
        <Button title="Retry what failed" kind="secondary" busy={busy === 'retry'} onPress={() => act('retry', `/projects/${id}/retry`)} />
      )}
      {message ? <Code>{message}</Code> : null}

      {(status === 'done' || status === 'failed') && (
        <Card>
          <Body style={styles.section}>Feedback</Body>
          <Muted>Ask for a change in your own words. More feedback while one is applying waits its turn.</Muted>
          <TextInput
            style={[styles.input, { color: theme.text, backgroundColor: theme.backgroundSelected }]}
            multiline
            value={feedback}
            onChangeText={setFeedback}
            placeholder="Make it…"
            placeholderTextColor={theme.textSecondary}
          />
          <Button
            title="Send feedback"
            busy={busy === 'feedback'}
            disabled={!feedback.trim()}
            onPress={async () => {
              await act('feedback', `/projects/${id}/feedback`, { text: feedback.trim() });
              setFeedback('');
            }}
          />
        </Card>
      )}

      <View style={styles.reports}>
        {REPORTS.map((r) => (
          <View key={r.kind} style={styles.report}>
            <Button title={r.title} kind="secondary" onPress={() => router.push({ pathname: '/project/[id]/report', params: { id, kind: r.kind } })} />
          </View>
        ))}
      </View>

      <Button title="Delete project" kind="destructive" onPress={destroy} />
    </Page>
  );
}

const styles = StyleSheet.create({
  section: { fontWeight: '700' },
  input: { borderRadius: 10, padding: Spacing.two + 2, fontSize: 16, minHeight: 90, textAlignVertical: 'top' },
  reports: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two },
  report: { flexGrow: 1, flexBasis: '30%' },
});
