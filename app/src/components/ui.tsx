import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View, type TextStyle } from 'react-native';

import { Fonts, MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/** A scrolling page that respects the safe area, with pull to refresh when given one. */
export function Page({ children, refreshing, onRefresh }: { children: ReactNode; refreshing?: boolean; onRefresh?: () => void }) {
  const theme = useTheme();
  return (
    <ScrollView
      style={{ backgroundColor: theme.background }}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.page}
      refreshControl={onRefresh ? <RefreshControl refreshing={refreshing ?? false} onRefresh={onRefresh} /> : undefined}>
      <View style={styles.column}>{children}</View>
    </ScrollView>
  );
}

export function Heading({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return <Text style={[styles.heading, { color: theme.text }]}>{children}</Text>;
}

export function Body({ children, style, selectable }: { children: ReactNode; style?: TextStyle; selectable?: boolean }) {
  const theme = useTheme();
  return (
    <Text selectable={selectable} style={[styles.body, { color: theme.text }, style]}>
      {children}
    </Text>
  );
}

export function Muted({ children, style }: { children: ReactNode; style?: TextStyle }) {
  const theme = useTheme();
  return <Text style={[styles.muted, { color: theme.textSecondary }, style]}>{children}</Text>;
}

/** Text that is a command or a log: monospaced, selectable. */
export function Code({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return (
    <Text selectable style={[styles.code, { color: theme.text, backgroundColor: theme.backgroundElement }]}>
      {children}
    </Text>
  );
}

export function Card({ children, onPress }: { children: ReactNode; onPress?: () => void }) {
  const theme = useTheme();
  const body = <View style={[styles.card, { backgroundColor: theme.backgroundElement }]}>{children}</View>;
  return onPress ? (
    <Pressable onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
      {body}
    </Pressable>
  ) : (
    body
  );
}

export function Button({
  title,
  onPress,
  kind = 'primary',
  busy,
  disabled,
}: {
  title: string;
  onPress: () => void;
  kind?: 'primary' | 'secondary' | 'destructive';
  busy?: boolean;
  disabled?: boolean;
}) {
  const theme = useTheme();
  const background = kind === 'primary' ? theme.accent : theme.backgroundElement;
  const color = kind === 'primary' ? theme.onAccent : kind === 'destructive' ? theme.bad : theme.text;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [styles.button, { backgroundColor: background, opacity: disabled ? 0.4 : pressed ? 0.7 : 1 }]}>
      {busy ? <ActivityIndicator color={color} /> : <Text style={[styles.buttonText, { color }]}>{title}</Text>}
    </Pressable>
  );
}

export function Tone({ tone, children }: { tone: 'active' | 'needs' | 'done' | 'bad'; children: ReactNode }) {
  const theme = useTheme();
  return <Text style={[styles.tone, { color: theme[tone] }]}>{children}</Text>;
}

export function ErrorText({ error }: { error: unknown }) {
  const theme = useTheme();
  if (!error) return null;
  return <Text style={[styles.body, { color: theme.bad }]}>{error instanceof Error ? error.message : String(error)}</Text>;
}

const styles = StyleSheet.create({
  page: { padding: Spacing.three, paddingBottom: Spacing.six, alignItems: 'center' },
  column: { width: '100%', maxWidth: MaxContentWidth, gap: Spacing.three },
  heading: { fontSize: 22, fontWeight: '700' },
  body: { fontSize: 16, lineHeight: 22 },
  muted: { fontSize: 14, lineHeight: 19 },
  code: { fontFamily: Fonts?.mono, fontSize: 13, lineHeight: 18, padding: Spacing.two, borderRadius: 8, overflow: 'hidden' },
  card: { borderRadius: 14, padding: Spacing.three, gap: Spacing.one },
  button: { borderRadius: 12, paddingVertical: 14, paddingHorizontal: Spacing.three, alignItems: 'center', justifyContent: 'center', minHeight: 48 },
  buttonText: { fontSize: 16, fontWeight: '600' },
  tone: { fontSize: 14, fontWeight: '600' },
});
