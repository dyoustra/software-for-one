import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, TextInput } from 'react-native';

import { Body, Button, Code, ErrorText, Heading, Muted, Page } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { createProject } from '@/lib/api';
import { useAuth } from '@/lib/auth';

export default function NewIdea() {
  const { token } = useAuth();
  const theme = useTheme();
  const [idea, setIdea] = useState('');
  const [budget, setBudget] = useState('');
  const [progress, setProgress] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function start() {
    if (!token) return;
    setBusy(true);
    setError(null);
    setProgress([]);
    try {
      await createProject(token, { idea: idea.trim(), ...(budget.trim() ? { budget: budget.trim() } : {}) }, (event) => {
        if ('progress' in event) setProgress((lines) => [...lines, event.progress.trim()]);
        if ('error' in event) setError(new Error(event.error));
        if ('done' in event) {
          setIdea('');
          setBudget('');
          router.push({ pathname: '/project/[id]', params: { id: event.project.id } });
        }
      });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const input = [styles.input, { color: theme.text, backgroundColor: theme.backgroundElement }];
  return (
    <Page>
      <Heading>New idea</Heading>
      <Muted>Say what you want, in your own words. Tap the microphone on the keyboard to dictate.</Muted>
      <TextInput
        style={[input, styles.idea]}
        multiline
        placeholder="A tool that…"
        placeholderTextColor={theme.textSecondary}
        value={idea}
        onChangeText={setIdea}
        editable={!busy}
      />
      <TextInput
        style={input}
        placeholder="Budget in dollars (optional)"
        placeholderTextColor={theme.textSecondary}
        keyboardType="decimal-pad"
        value={budget}
        onChangeText={setBudget}
        editable={!busy}
      />
      <Button title={busy ? 'Setting it up…' : 'Build it'} onPress={start} busy={busy} disabled={!idea.trim()} />
      <ErrorText error={error} />
      {progress.length > 0 && (
        <>
          <Body>Setting up its own machine (about a minute):</Body>
          <Code>{progress.join('\n\n')}</Code>
        </>
      )}
    </Page>
  );
}

const styles = StyleSheet.create({
  input: { borderRadius: 12, padding: Spacing.three, fontSize: 16 },
  idea: { minHeight: 140, textAlignVertical: 'top' },
});
