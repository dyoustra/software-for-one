import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { Question } from '@sfo/api';
import { Artifacts } from '@/components/artifacts';
import { Body, Button, Card, ErrorText, Muted, Page } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useAuth } from '@/lib/auth';

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
      router.back();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page>
      <ErrorText error={error} />
      <Artifacts id={id} kind="drafts" />
      {questions?.map((q) => {
        const d = drafts[q.id] ?? { key: null, words: '' };
        return (
          <Card key={q.id}>
            <Muted>{q.section === 'blocking' ? 'Needed to go on' : 'A preference (there is a default)'}</Muted>
            <Body style={styles.question}>{q.text}</Body>
            {q.context ? <Muted>{q.context}</Muted> : null}
            {q.options.map((o) => {
              const chosen = d.key === o.key;
              return (
                <Pressable
                  key={o.key}
                  onPress={() => setDrafts({ ...drafts, [q.id]: { ...d, key: chosen ? null : o.key } })}
                  style={[styles.option, { backgroundColor: chosen ? theme.accent : theme.backgroundSelected }]}>
                  <Text style={[styles.optionLabel, { color: chosen ? theme.onAccent : theme.text }]}>{o.label}</Text>
                  <Text style={{ color: chosen ? theme.onAccent : theme.textSecondary }}>{o.tradeoff}</Text>
                </Pressable>
              );
            })}
            <TextInput
              style={[styles.input, { color: theme.text, backgroundColor: theme.backgroundSelected }]}
              multiline
              placeholder={d.key ? 'Anything to add? (optional)' : 'Or say it in your own words'}
              placeholderTextColor={theme.textSecondary}
              value={d.words}
              onChangeText={(words) => setDrafts({ ...drafts, [q.id]: { ...d, words } })}
            />
          </Card>
        );
      })}
      {questions && (
        <View style={{ gap: Spacing.two }}>
          {unanswered.length > 0 && <Muted>{unanswered.length} still to answer</Muted>}
          <Button title="Send answers" busy={busy} disabled={unanswered.length > 0} onPress={submit} />
        </View>
      )}
    </Page>
  );
}

const styles = StyleSheet.create({
  question: { fontWeight: '700' },
  option: { borderRadius: 12, padding: Spacing.three, gap: Spacing.one, marginTop: Spacing.two },
  optionLabel: { fontSize: 16, fontWeight: '600' },
  input: { borderRadius: 10, padding: Spacing.two + 2, fontSize: 16, marginTop: Spacing.two, minHeight: 48 },
});
