import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import type { Delivery, ProjectResults } from '@sfo/api';
import { Artifacts } from '@/components/artifacts';
import { Loading, Telemetry } from '@/components/ui';
import { Radius, Spacing, Type } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useCached } from '@/lib/cache';
import { formatDuration, formatSpend } from '@/lib/pipeline';

/** A project's results: the cached copy at once, refreshed each time the screen comes into view. */
export function useResults(id: string) {
  const { data: results, error } = useCached<ProjectResults>(`/projects/${id}/results`);
  return { results, error };
}

/** Opens only web addresses, whatever a delivery says. */
function openWeb(url: string) {
  if (/^https?:\/\//i.test(url)) Linking.openURL(url);
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const theme = useTheme();
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: theme.ink }]} accessibilityRole="header">
        {title}
      </Text>
      {children}
    </View>
  );
}

/** A command to type: mono in a well, selectable (long-press to copy). */
function Command({ command, label }: { command: string; label?: string }) {
  const theme = useTheme();
  return (
    <View style={styles.command}>
      {label ? <Text style={[styles.label, { color: theme.inkMuted }]}>{label}</Text> : null}
      <Text selectable style={[Type.telemetry, styles.commandText, { color: theme.ink, backgroundColor: theme.well }]}>
        {command}
      </Text>
    </View>
  );
}

const GAP_TONE = { blocks: 'failed', limits: 'waiting', note: 'inkMuted' } as const;

/**
 * What a finished project is and how to use it (RESULTS_SPEC §5), from its
 * DELIVERY.json, or, for one delivered before that existed, from what sfo
 * recorded: the commands it installed and the groups of its criteria.
 */
export function Delivered({ id, results }: { id: string; results: ProjectResults | null }) {
  const theme = useTheme();
  if (!results) return <Loading label="Reading what it built…" />;
  const d: Delivery | null = results.delivery;
  const use: Delivery['use'] = d?.use ?? results.installed.map((command) => ({ kind: 'command' as const, command }));
  const features = d?.features ?? results.featuresFallback;
  const passed = results.slices.filter((s) => s.result === 'passed').length;

  return (
    <View style={styles.delivered}>
      {d && <Text style={[styles.what, { color: theme.ink }]}>{d.what}</Text>}

      {use.length > 0 && (
        <Section title="How to use it">
          {use.map((u, i) =>
            u.kind === 'command' ? (
              <Command key={i} command={u.command} label={u.label} />
            ) : u.kind === 'url' ? (
              <Pressable key={i} accessibilityRole="link" onPress={() => openWeb(u.url)}>
                <Text style={[Type.body, { color: theme.accent }]}>{u.label ?? u.url}</Text>
              </Pressable>
            ) : (
              <Text key={i} style={[Type.body, { color: theme.ink }]}>
                {u.text}
              </Text>
            ),
          )}
        </Section>
      )}

      {d && d.examples.length > 0 && (
        <Section title="Examples">
          {d.examples.map((e, i) => (
            <Command key={i} command={e.do} label={e.say} />
          ))}
        </Section>
      )}

      {features.length > 0 && (
        <Section title="What it does">
          {features.map((f, i) => (
            <View key={i} style={styles.bullet}>
              <Text style={[Type.body, { color: theme.inkMuted }]}>•</Text>
              <Text style={[Type.body, { color: theme.ink, flex: 1 }]}>{f}</Text>
            </View>
          ))}
        </Section>
      )}

      {d && d.gaps.length > 0 && (
        <Section title="Known gaps">
          {d.gaps.map((g, i) => (
            <View key={i} style={styles.bullet}>
              <Text style={[Type.body, { color: theme[GAP_TONE[g.weight]] }]}>{g.weight === 'note' ? '•' : '!'}</Text>
              <Text style={[Type.body, { color: g.weight === 'note' ? theme.inkMuted : theme.ink, flex: 1 }]}>{g.text}</Text>
            </View>
          ))}
        </Section>
      )}

      <Artifacts id={id} kind="renders" />

      <Telemetry>
        {[formatSpend(results.cost.totalUsd), results.cost.computeMs ? formatDuration(results.cost.computeMs) : null, results.slices.length ? `${passed}/${results.slices.length} slices` : null]
          .filter(Boolean)
          .join('    ')}
      </Telemetry>
    </View>
  );
}

const styles = StyleSheet.create({
  delivered: { gap: Spacing.four },
  what: { fontSize: 19, lineHeight: 26, fontWeight: '500' },
  section: { gap: Spacing.two },
  sectionTitle: { fontSize: 15, fontWeight: '700' },
  command: { gap: 4 },
  label: { fontSize: 14 },
  commandText: { fontSize: 14, padding: Spacing.three, borderRadius: Radius.control, overflow: 'hidden' },
  bullet: { flexDirection: 'row', gap: Spacing.two },
});

