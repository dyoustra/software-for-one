import { StyleSheet, Text, View } from 'react-native';

import type { Project } from '@sfo/api';
import { Rail } from '@/components/rail';
import { Badge, Card, Telemetry } from '@/components/ui';
import { Type } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { cardModel, type CardModel } from '@/lib/pipeline';

/**
 * A project at a glance (THEME_SPEC §6): title and badge, the rail while the
 * run is in progress, and one footer of telemetry in fixed columns so they
 * line up down a list. Kept self-contained: a Lock Screen Live Activity can
 * mirror these three rows later.
 */
export function ProjectCard({ project, onPress }: { project: Project; onPress?: () => void }) {
  const m = cardModel(project);
  return (
    <Card onPress={onPress} tone={m.kind === 'waiting' ? 'waiting' : undefined} style={styles.card}>
      <View style={styles.header}>
        <CardTitle text={m.title} />
        <Badge tone={m.badge.tone}>{m.badge.text}</Badge>
      </View>
      {m.rail && <Rail at={m.rail.at} tone={m.rail.tone} halo={m.rail.halo} />}
      <Footer m={m} />
    </Card>
  );
}

function CardTitle({ text }: { text: string }) {
  const theme = useTheme();
  return (
    <Text numberOfLines={1} style={[Type.cardTitle, styles.title, { color: theme.ink }]}>
      {text}
    </Text>
  );
}

function Footer({ m }: { m: CardModel }) {
  const theme = useTheme();
  const words = m.line && !m.lineIsCode;
  return (
    <View style={styles.footer}>
      <View style={styles.lead}>
        {words ? (
          <Text numberOfLines={2} style={[styles.words, { color: theme.inkMuted }]}>
            {m.line}
          </Text>
        ) : m.lineIsCode ? (
          <Telemetry style={{ color: theme.ink }}>{m.line}</Telemetry>
        ) : m.slices && m.kind !== 'done' ? (
          <Slices {...m.slices} tone={m.rail?.tone ?? 'done'} />
        ) : null}
      </View>
      {m.kind === 'done' && m.slices && <Telemetry style={styles.column}>{`${m.slices.passed}/${m.slices.total}`}</Telemetry>}
      {m.spend !== undefined && <Telemetry style={styles.column}>{m.spend}</Telemetry>}
      {m.time !== undefined && <Telemetry style={styles.column}>{m.time}</Telemetry>}
    </View>
  );
}

/** One dot per planned slice, lit as each passes, then the count. */
function Slices({ passed, failed, total, tone }: { passed: number; failed: number; total: number; tone: 'running' | 'waiting' | 'done' | 'failed' }) {
  const theme = useTheme();
  const dots = Math.min(total, 12);
  return (
    <View style={styles.slices} accessibilityLabel={`${passed} of ${total} slices done`}>
      {Array.from({ length: dots }, (_, i) => (
        <View key={i} style={[styles.sliceDot, { backgroundColor: i < passed ? theme[tone] : i < passed + failed ? theme.failed : theme.line }]} />
      ))}
      <Telemetry style={styles.sliceCount}>{`${passed}/${total}`}</Telemetry>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: 10 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  title: { flex: 1 },
  footer: { flexDirection: 'row', alignItems: 'center', minHeight: 18 },
  lead: { flex: 1, marginRight: 8 },
  words: { fontSize: 14, lineHeight: 19 },
  // Fixed widths, so spend and time sit in the same place on every card.
  column: { width: 64, textAlign: 'right' },
  slices: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  sliceDot: { width: 6, height: 6, borderRadius: 3 },
  sliceCount: { marginLeft: 4 },
});
