import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import type { Project, Question } from '@sfo/api';
import { Artifacts } from '@/components/artifacts';
import { ProjectCard } from '@/components/project-card';
import { Body, Button, Card, Code, ErrorText, Field, Muted, Page, Telemetry } from '@/components/ui';
import { Radius, Spacing, tint, Type } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { startProject } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { confirm } from '@/lib/confirm';
import { cardModel } from '@/lib/pipeline';
import { useProjects } from '@/lib/projects';

const REPORTS = [
  { kind: 'summary', title: 'Summary' },
  { kind: 'decisions', title: 'Decisions' },
  { kind: 'criteria', title: 'Criteria' },
  { kind: 'slices', title: 'Slices' },
  { kind: 'cost', title: 'Cost' },
  { kind: 'logs', title: 'Current log' },
] as const;

export default function ProjectScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api, token } = useAuth();
  const { refresh: refreshList } = useProjects();
  const [project, setProject] = useState<Project | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const live = useRef(false);

  const load = useCallback(async () => {
    try {
      const p = await api<Project>(`/projects/${id}`);
      setProject(p);
      const kind = cardModel(p).kind;
      live.current = kind === 'running' || kind === 'setup';
      setQuestions(p.summary?.status === 'awaiting_human' ? await api<Question[]>(`/projects/${id}/questions`) : []);
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [api, id]);

  useFocusEffect(
    useCallback(() => {
      load();
      const timer = setInterval(() => live.current && load(), 15_000);
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
      refreshList();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  async function remove(settingUp: boolean) {
    const message = settingUp
      ? 'Its record goes; nothing was built.'
      : `Its machine and everything on it go${project?.repo ? '; its GitHub repo stays.' : ', and it has no repo: this is the only copy.'}`;
    if (!(await confirm(settingUp ? 'Remove this setup?' : 'Delete this project?', message, settingUp ? 'Remove' : 'Delete'))) return;
    try {
      await api(`/projects/${id}`, { method: 'DELETE' });
      await refreshList();
      if (router.canGoBack()) router.back();
      else router.replace('/projects');
    } catch (err) {
      setError(err);
    }
  }

  /** A failed setup, started again from the same idea; the failed record goes. */
  async function setUpAgain() {
    if (!token || !project?.idea) return;
    setBusy('again');
    try {
      await startProject(token, { idea: project.idea });
      await api(`/projects/${id}`, { method: 'DELETE' });
      await refreshList();
      router.replace('/projects');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  const summary = project?.summary ?? null;
  const kind = project ? cardModel(project).kind : null;
  const settingUp = project?.status === 'creating';
  const status = summary?.status;

  return (
    <Page refreshing={false} onRefresh={load}>
      <Stack.Screen options={{ title: summary?.title ?? (settingUp ? 'Setting up' : 'Project') }} />
      <ErrorText error={error} />
      {project && <ProjectCard project={project} />}
      {summary?.note && (status === 'awaiting_human' || status === 'done') ? (
        <Card>
          <Body selectable>{summary.note.replace(/^stopped: /, '')}</Body>
        </Card>
      ) : null}

      {settingUp && project?.setup?.error && (
        <>
          <Button title="Try again" busy={busy === 'again'} onPress={setUpAgain} />
          <Button title="Remove" kind="destructive" onPress={() => remove(true)} />
        </>
      )}
      {settingUp && !project?.setup?.error && <Muted>Setting up takes about a minute. You can leave; it carries on.</Muted>}

      {questions.length > 0 && (
        <Button
          title={`Answer ${questions.length} question${questions.length === 1 ? '' : 's'}`}
          onPress={() => router.push({ pathname: '/project/[id]/questions', params: { id } })}
        />
      )}
      {status === 'awaiting_human' && questions.length === 0 && <Button title={summary?.note?.startsWith('stopped:') ? 'Build it anyway' : 'Resume'} busy={busy === 'run'} onPress={() => act('run', `/projects/${id}/run`)} />}
      {(status === 'failed' || (status === 'done' && /fail|unresolved/.test(summary?.note ?? ''))) && (
        <Button title="Retry what failed" busy={busy === 'retry'} onPress={() => act('retry', `/projects/${id}/retry`)} />
      )}
      {status === 'running' && <Button title="Stop" kind="secondary" busy={busy === 'stop'} onPress={() => act('stop', `/projects/${id}/stop`)} />}
      {message ? <Code>{message}</Code> : null}

      {summary?.slicesTotal ? <SliceBreakdown ids={summary.sliceIds} passed={summary.slicesPassed ?? []} failed={summary.slicesFailed ?? []} total={summary.slicesTotal} /> : null}

      {(kind === 'done' || status === 'failed') && (
        <Card>
          <Body style={styles.section}>Ask for a change</Body>
          <Muted>In your own words. A second request while one is applying waits its turn.</Muted>
          <Field multiline value={feedback} onChangeText={setFeedback} placeholder="Make it…" style={styles.feedback} />
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

      {kind === 'done' && <Artifacts id={id} kind="renders" />}

      {!settingUp && project && (
        <Card style={styles.rows}>
          {REPORTS.map((r, i) => (
            <Row key={r.kind} first={i === 0} title={r.title} onPress={() => router.push({ pathname: '/project/[id]/report', params: { id, kind: r.kind } })} />
          ))}
          {project.repo && <Row title="Open repo" detail={project.repo.replace(/^https?:\/\/(www\.)?github\.com\//, '')} onPress={() => Linking.openURL(project.repo!)} />}
        </Card>
      )}

      {!settingUp && project && <Button title="Delete project" kind="destructive" onPress={() => remove(false)} />}
    </Page>
  );
}

/** One pill per planned slice: passed, failed, or still to come. */
function SliceBreakdown({ ids: planned, passed, failed, total }: { ids?: string[]; passed: string[]; failed: string[]; total: number }) {
  const theme = useTheme();
  // A summary from an older Sprite has only the count: sfo's plans number slices S-01, S-02, …
  const ids = planned ?? Array.from({ length: total }, (_, i) => `S-${String(i + 1).padStart(2, '0')}`);
  return (
    <View style={styles.slices} accessibilityLabel={`${passed.length} of ${total} slices passed${failed.length ? `, ${failed.length} failed` : ''}`}>
      {ids.map((s) => {
        const tone = passed.includes(s) ? theme.done : failed.includes(s) ? theme.failed : null;
        return (
          <View key={s} style={[styles.pill, { borderColor: tone ? tint(tone, 0.4) : theme.line, backgroundColor: tone ? tint(tone, 0.12) : 'transparent' }]}>
            <Telemetry style={{ color: tone ?? theme.inkMuted }}>{s}</Telemetry>
          </View>
        );
      })}
    </View>
  );
}

function Row({ title, detail, first, onPress }: { title: string; detail?: string; first?: boolean; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.row, !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.line }, pressed && { opacity: 0.6 }]}>
      <Text style={[Type.body, { color: theme.ink, flex: 1 }]}>{title}</Text>
      {detail && (
        <Telemetry numberOfLines={1} style={styles.detail}>
          {detail}
        </Telemetry>
      )}
      <Text style={[Type.body, { color: theme.inkMuted }]}>›</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  section: { fontWeight: '600' },
  feedback: { minHeight: 90 },
  slices: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two },
  pill: { borderWidth: 1, borderRadius: Radius.pill, paddingVertical: 3, paddingHorizontal: 9 },
  rows: { paddingVertical: 0, gap: 0 },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two, paddingVertical: 13 },
  detail: { maxWidth: '55%' },
});
