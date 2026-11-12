import { Stack, useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import type { ProjectResults } from '@sfo/api';
import { useResults } from '@/components/results';
import { Badge, Card, ErrorText, Loading, Muted, Page, Telemetry } from '@/components/ui';
import { Spacing, Type } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

const RESULT: Record<ProjectResults['slices'][number]['result'], { tone: 'done' | 'failed' | 'waiting' | 'running'; text: string }> = {
  passed: { tone: 'done', text: 'Passed' },
  failed: { tone: 'failed', text: 'Failed' },
  skipped: { tone: 'waiting', text: 'Skipped' },
  pending: { tone: 'running', text: 'To build' },
};

/** The plan's slices and how each went (RESULTS_SPEC §5). */
export default function SlicesScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { results, error } = useResults(id);
  const theme = useTheme();

  return (
    <Page>
      <Stack.Screen options={{ title: 'Slices' }} />
      <ErrorText error={error} />
      {!results && !error && <Loading label="Reading the plan…" />}
      {results && results.slices.length === 0 && <Muted>No plan yet: slices appear once the run plans the build.</Muted>}
      {results && results.slices.length > 0 && (
        <Card style={styles.rows}>
          {results.slices.map((s, i) => (
            <View key={s.id} style={[styles.row, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.line }]}>
              <View style={styles.head}>
                <Telemetry style={styles.id}>{s.id}</Telemetry>
                <Text style={[Type.body, { color: theme.ink, flex: 1 }]} numberOfLines={2}>
                  {s.name}
                </Text>
                <Badge tone={RESULT[s.result].tone}>{RESULT[s.result].text}</Badge>
              </View>
              <Telemetry style={styles.meta}>
                {[s.attempts > 1 ? `${s.attempts} tries` : s.attempts === 1 ? '1 try' : null, `${s.criteria.length} ${s.criteria.length === 1 ? 'criterion' : 'criteria'}`].filter(Boolean).join('    ')}
              </Telemetry>
            </View>
          ))}
        </Card>
      )}
    </Page>
  );
}

const styles = StyleSheet.create({
  rows: { paddingVertical: Spacing.one, gap: 0 },
  row: { paddingVertical: 12, gap: 4 },
  head: { flexDirection: 'row', alignItems: 'center', gap: Spacing.three },
  id: { width: 40 },
  meta: { marginLeft: 40 + Spacing.three },
});
