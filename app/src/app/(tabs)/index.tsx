import { router } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInUp, FadeOut, LinearTransition } from 'react-native-reanimated';

import type { Project } from '@sfo/api';
import { ProjectCard } from '@/components/project-card';
import { Button, ErrorText, Field } from '@/components/ui';
import { MaxContentWidth, Spacing, Type } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { startProject } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useProjects } from '@/lib/projects';

/** A run waiting on the person opens straight to what it is waiting for. */
function openWaiting(p: Project) {
  if (p.summary?.openQuestions) router.push({ pathname: '/project/[id]/questions', params: { id: p.id } });
  else router.push({ pathname: '/project/[id]', params: { id: p.id } });
}

/**
 * Home: a near-empty canvas for dropping an idea and leaving (THEME_SPEC §5).
 * Only a run waiting on the person is shown above it, and the project just
 * started, settling in as a card.
 */
export default function Idea() {
  const { token } = useAuth();
  const { projects, waiting, refresh } = useProjects();
  const theme = useTheme();
  const [idea, setIdea] = useState('');
  const [budget, setBudget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [startedAt, setStartedAt] = useState<string | null>(null);

  // The started project as the list now has it, so its card follows setup.
  // Found by when it was created: once set up, it trades its provisional id
  // for the real one.
  const started = startedAt ? (projects?.find((p) => p.createdAt === startedAt) ?? null) : null;
  const longest = waiting[0];

  async function start() {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const project = await startProject(token, { idea: idea.trim(), ...(budget.trim() ? { budget: budget.trim() } : {}) });
      setIdea('');
      setBudget('');
      setStartedAt(project.createdAt);
      await refresh();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: theme.canvas }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" contentContainerStyle={styles.scroll}>
        <View style={styles.column}>
          {longest && (
            <Animated.View layout={LinearTransition} style={styles.stack}>
              <ProjectCard project={longest} onPress={() => openWaiting(longest)} />
              {waiting.length > 1 && (
                <Pressable accessibilityRole="link" onPress={() => router.push('/projects')}>
                  <Text style={[Type.label, { color: theme.waiting }]}>{`${waiting.length - 1} more waiting`}</Text>
                </Pressable>
              )}
            </Animated.View>
          )}

          {started && (
            <Animated.View entering={FadeInUp.duration(500)} exiting={FadeOut.duration(200)} layout={LinearTransition}>
              <ProjectCard project={started} onPress={() => router.push('/projects')} />
            </Animated.View>
          )}

          <Animated.View layout={LinearTransition} style={[styles.canvas, !longest && !started && styles.canvasAlone]}>
            <Text style={[Type.prompt, { color: theme.ink }]} accessibilityRole="header">
              What do you want built?
            </Text>
            <Field
              multiline
              placeholder="Describe it in your own words. Dictation works too."
              value={idea}
              onChangeText={(text) => {
                setIdea(text);
                if (startedAt) setStartedAt(null);
              }}
              editable={!busy}
              style={styles.idea}
            />
            <Field
              placeholder="Spending limit in dollars (optional)"
              keyboardType="decimal-pad"
              value={budget}
              onChangeText={setBudget}
              editable={!busy}
            />
            <Button title="Start building" onPress={start} busy={busy} disabled={!idea.trim()} />
            <ErrorText error={error} />
          </Animated.View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 1, padding: Spacing.three, paddingBottom: Spacing.six, alignItems: 'center' },
  column: { width: '100%', maxWidth: MaxContentWidth, gap: Spacing.four, flexGrow: 1 },
  stack: { gap: Spacing.two },
  canvas: { gap: Spacing.three },
  // Alone on the screen, the prompt sits a third of the way down rather than against the top.
  canvasAlone: { marginTop: '22%' },
  idea: { minHeight: 160 },
});
