import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

import { MaxContentWidth, Radius, Spacing, tint, Type, type Tone as ToneName } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/** A scrolling page on the canvas that respects the safe area, with pull to refresh when given one. */
export function Page({ children, refreshing, onRefresh }: { children: ReactNode; refreshing?: boolean; onRefresh?: () => void }) {
  const theme = useTheme();
  return (
    <ScrollView
      style={{ backgroundColor: theme.canvas }}
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
  return <Text style={[Type.title, { color: theme.ink }]}>{children}</Text>;
}

export function Body({ children, style, selectable }: { children: ReactNode; style?: TextStyle; selectable?: boolean }) {
  const theme = useTheme();
  return (
    <Text selectable={selectable} style={[Type.body, { color: theme.ink }, style]}>
      {children}
    </Text>
  );
}

export function Muted({ children, style }: { children: ReactNode; style?: TextStyle }) {
  const theme = useTheme();
  return <Text style={[styles.muted, { color: theme.inkMuted }, style]}>{children}</Text>;
}

/** A machine fact: a count, a sum of money, a duration, a stage. Monospaced, tabular. */
export function Telemetry({ children, tone, style, numberOfLines }: { children: ReactNode; tone?: ToneName; style?: TextStyle; numberOfLines?: number }) {
  const theme = useTheme();
  return (
    <Text numberOfLines={numberOfLines} style={[Type.telemetry, { color: tone ? theme[tone] : theme.inkMuted }, style]}>
      {children}
    </Text>
  );
}

/** Text that is a command or a log: monospaced, selectable, set into a well. */
export function Code({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return (
    <Text selectable style={[Type.telemetry, styles.code, { color: theme.ink, backgroundColor: theme.well }]}>
      {children}
    </Text>
  );
}

/** A surface with a fine border; a tone tints the border, for a card that needs attention. */
export function Card({ children, onPress, tone, style }: { children: ReactNode; onPress?: () => void; tone?: ToneName; style?: ViewStyle }) {
  const theme = useTheme();
  const frame = [styles.card, { backgroundColor: theme.surface, borderColor: tone ? tint(theme[tone], 0.45) : theme.line }, style];
  return onPress ? (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [frame, pressed && { opacity: 0.75 }]}>
      {children}
    </Pressable>
  ) : (
    <View style={frame}>{children}</View>
  );
}

/** A state, said quietly: tinted translucent fill, coloured text, a fine border. */
export function Badge({ tone, children }: { tone: ToneName; children: ReactNode }) {
  const theme = useTheme();
  return (
    <View style={[styles.badge, { backgroundColor: tint(theme[tone], 0.14), borderColor: tint(theme[tone], 0.35) }]}>
      <Text style={[Type.label, { color: theme[tone] }]} numberOfLines={1}>
        {children}
      </Text>
    </View>
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
  const primary = kind === 'primary';
  const color = primary ? theme.onAccent : kind === 'destructive' ? theme.failed : theme.ink;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || busy, busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        primary ? { backgroundColor: theme.accent } : { backgroundColor: theme.surface, borderColor: theme.line, borderWidth: StyleSheet.hairlineWidth * 2 },
        { opacity: disabled ? 0.4 : pressed ? 0.75 : 1 },
      ]}>
      {busy ? <ActivityIndicator color={color} /> : <Text style={[styles.buttonText, { color }]}>{title}</Text>}
    </Pressable>
  );
}

/** A text input set into a well. */
export function Field({ style, ...props }: TextInputProps) {
  const theme = useTheme();
  return (
    <TextInput
      placeholderTextColor={theme.inkMuted}
      {...props}
      style={[Type.body, styles.field, { color: theme.ink, backgroundColor: theme.well }, props.multiline && styles.fieldLong, style]}
    />
  );
}

/** What went wrong, in the failed colour. */
export function ErrorText({ error }: { error: unknown }) {
  const theme = useTheme();
  if (!error) return null;
  return <Text style={[Type.body, { color: theme.failed }]}>{error instanceof Error ? error.message : String(error)}</Text>;
}

const styles = StyleSheet.create({
  page: { padding: Spacing.three, paddingBottom: Spacing.six, alignItems: 'center' },
  column: { width: '100%', maxWidth: MaxContentWidth, gap: Spacing.three },
  muted: { fontSize: 14, lineHeight: 19 },
  code: { padding: Spacing.three, borderRadius: Radius.control, overflow: 'hidden' },
  card: { borderRadius: Radius.card, borderWidth: 1, padding: Spacing.three, gap: Spacing.two },
  badge: { borderRadius: Radius.pill, borderWidth: 1, paddingVertical: 3, paddingHorizontal: 10, alignSelf: 'flex-start' },
  button: { borderRadius: Radius.control, paddingVertical: 14, paddingHorizontal: Spacing.three, alignItems: 'center', justifyContent: 'center', minHeight: 50 },
  buttonText: { fontSize: 16, fontWeight: '600' },
  field: { borderRadius: Radius.control, paddingVertical: 12, paddingHorizontal: 14 },
  fieldLong: { minHeight: 120, textAlignVertical: 'top' },
});
