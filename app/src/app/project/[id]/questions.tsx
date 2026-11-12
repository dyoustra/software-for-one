import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { Question } from '@sfo/api';
import { Artifacts } from '@/components/artifacts';
import { Rail } from '@/components/rail';
import { Badge, Button, Card, ErrorText, Field, Loading, Muted, Page } from '@/components/ui';
import { Radius, Spacing, tint, Type } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useAuth } from '@/lib/auth';
import { cardModel } from '@/lib/pipeline';
import { useProjects } from '@/lib/projects';

/** Each question's choice and, optionally, words of the person's own. */
type Draft = { key: string | null; words: string };

/**
 * What is sent for one question: the option, qualified by any words — "A,
 * but with a --materialize flag" is a real requirement, not just "A".
 */
function answerText(q: Question, d: Draft): string {
  const option = q.options.find((o) => o.key === d.key);
  const words = d.words.trim();
  if (option && words) return `${option.key} (${option.label}), but: ${words}`;
  if (option) return option.key;
  return words;
}

export default function Questions() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api } = useAuth();
  const { projects, refresh } = useProjects();
  const theme = useTheme();
  const [questions, setQuestions] = useState<Question[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api<Question[]>(`/projects/${id}/questions`).then((qs) => {
      setQuestions(qs);
      setDrafts(Object.fromEntries(qs.map((q) => [q.id, { key: null, words: '' }])));
    }, setError);
  }, [api, id]);

  const unanswered = (questions ?? []).filter((q) => !answerText(q, drafts[q.id] ?? { key: null, words: '' }));

  async function submit() {
    if (!questions) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/projects/${id}/answers`, { method: 'POST', body: Object.fromEntries(questions.map((q) => [q.id, answerText(q, drafts[q.id])])) });
      refresh();
      router.back();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const project = projects?.find((p) => p.id === id);
  const model = project ? cardModel(project) : null;

  return (
    <Page>
      {model?.rail && (
        <View style={styles.where}>
          <Muted>{`${model.title} is waiting for you at`}</Muted>
          <Rail at={model.rail.at} tone="waiting" halo="steady" />
        </View>
      )}
      <ErrorText error={error} />
      {!questions && !error && <Loading label="Fetching the questions…" />}
      <Artifacts id={id} kind="drafts" />
      {questions?.map((q) => {
        const d = drafts[q.id] ?? { key: null, words: '' };
        return (
          <Card key={q.id} style={styles.question}>
            {q.section === 'blocking' ? <Badge tone="waiting">Needed to go on</Badge> : <Muted>A preference: there is a default</Muted>}
            <Text style={[Type.cardTitle, styles.questionText, { color: theme.ink }]}>{q.text}</Text>
            {q.context ? <Muted>{q.context}</Muted> : null}
            {q.options.map((o) => {
              const chosen = d.key === o.key;
              return (
                <Pressable
                  key={o.key}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: chosen }}
                  onPress={() => setDrafts({ ...drafts, [q.id]: { ...d, key: chosen ? null : o.key } })}
                  style={[
                    styles.option,
                    { borderColor: chosen ? theme.accent : theme.line, backgroundColor: chosen ? tint(theme.accent, 0.1) : theme.surface },
                  ]}>
                  <View style={[styles.key, chosen ? { backgroundColor: theme.accent, borderColor: theme.accent } : { borderColor: theme.line }]}>
                    <Text style={[Type.label, { color: chosen ? theme.onAccent : theme.inkMuted }]}>{chosen ? '✓' : o.key}</Text>
                  </View>
                  <View style={styles.optionText}>
                    <Text style={[Type.body, styles.optionLabel, { color: theme.ink }]}>{o.label}</Text>
                    {o.tradeoff ? <Text style={[styles.tradeoff, { color: theme.inkMuted }]}>{o.tradeoff}</Text> : null}
                  </View>
                </Pressable>
              );
            })}
            <Field
              multiline
              placeholder={d.key ? 'Add a note (optional)' : 'Or answer in your own words'}
              value={d.words}
              onChangeText={(words) => setDrafts({ ...drafts, [q.id]: { ...d, words } })}
              style={styles.note}
            />
          </Card>
        );
      })}
      {questions && (
        <View style={{ gap: Spacing.two }}>
          {unanswered.length > 0 && <Muted>{`${unanswered.length} still to answer`}</Muted>}
          <Button title="Send answers" busy={busy} disabled={unanswered.length > 0} onPress={submit} />
        </View>
      )}
    </Page>
  );
}

const styles = StyleSheet.create({
  where: { gap: Spacing.one },
  question: { gap: Spacing.two + 2 },
  questionText: { fontSize: 18, lineHeight: 24 },
  option: { flexDirection: 'row', gap: Spacing.three, alignItems: 'flex-start', borderWidth: 1, borderRadius: Radius.control, padding: Spacing.three },
  key: { width: 24, height: 24, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  optionText: { flex: 1, gap: 2 },
  optionLabel: { fontWeight: '600' },
  tradeoff: { fontSize: 14, lineHeight: 19 },
  note: { minHeight: 48 },
});
