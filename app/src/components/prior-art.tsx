import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import type { PriorArt } from '@sfo/api';
import { Button, Card, Telemetry } from '@/components/ui';
import { Spacing, Type } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/** The host a link goes to, shown beside it: research found these links, and some point at odd places. */
function host(url: string): string | null {
  try {
    const u = new URL(url);
    return ['http:', 'https:'].includes(u.protocol) ? u.host : null;
  } catch {
    return null;
  }
}

/**
 * A run research stopped because something like it exists: what was found,
 * what it suggests, and the person's two choices.
 */
export function PriorArtDecision({ art, busy, onBuild, onDrop }: { art: PriorArt; busy: boolean; onBuild: () => void; onDrop: () => void }) {
  const theme = useTheme();
  return (
    <Card tone="waiting">
      <Text style={[Type.cardTitle, { color: theme.ink }]}>{art.verdict === 'no_gap' ? 'This already exists' : 'Something close already exists'}</Text>
      <Text style={[Type.body, { color: theme.ink }]}>{art.summary}</Text>
      {art.recommendation ? <Text style={[Type.body, { color: theme.inkMuted }]}>{art.recommendation}</Text> : null}

      <View style={styles.list}>
        {art.existing.map((e, i) => {
          const where = host(e.url);
          return (
            <View key={i} style={[styles.item, { borderTopColor: theme.line }]}>
              <View style={styles.itemHead}>
                {where ? (
                  <Pressable accessibilityRole="link" accessibilityHint={`Opens ${where}`} onPress={() => Linking.openURL(e.url)} style={{ flex: 1 }}>
                    <Text style={[Type.body, styles.name, { color: theme.accent }]}>{e.name}</Text>
                  </Pressable>
                ) : (
                  <Text style={[Type.body, styles.name, { color: theme.ink, flex: 1 }]}>{e.name}</Text>
                )}
                {where && <Telemetry numberOfLines={1} style={styles.host}>{where}</Telemetry>}
              </View>
              <Text style={[styles.gap, { color: theme.inkMuted }]}>{e.gap}</Text>
            </View>
          );
        })}
      </View>

      <View style={styles.actions}>
        <Button title="Build it anyway" busy={busy} onPress={onBuild} />
        <Button title="Don't build it" kind="destructive" onPress={onDrop} />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  list: { marginTop: Spacing.one },
  item: { borderTopWidth: StyleSheet.hairlineWidth, paddingVertical: 10, gap: 2 },
  itemHead: { flexDirection: 'row', alignItems: 'baseline', gap: Spacing.two },
  name: { fontWeight: '600' },
  host: { maxWidth: '50%' },
  gap: { fontSize: 14, lineHeight: 19 },
  actions: { gap: Spacing.two, marginTop: Spacing.two },
});
