import { Stack, useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { useResults } from '@/components/results';
import { Card, ErrorText, Loading, Muted, Page, Telemetry } from '@/components/ui';
import { Radius, Spacing, tint, Type } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { stageName } from '@/lib/log';
import { formatDuration, formatSpend } from '@/lib/pipeline';

/** "claude-opus-5-5" → "Opus 5.5". */
function modelName(id: string): string {
  const m = id.match(/^claude-(haiku|sonnet|opus)-(\d+)-(\d+)/);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : id;
}

/** What a project cost, stage by stage (RESULTS_SPEC §5). */
export default function CostScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { results, error } = useResults(id);
  const theme = useTheme();
  const cost = results?.cost;
  const most = Math.max(...(cost?.byStage.map((s) => s.costUsd) ?? [0]), 0.01);
  const viaPlan = cost?.byStage.some((s) => s.billing === 'plan');
  const viaApi = cost?.byStage.some((s) => s.billing === 'api');

  return (
    <Page>
      <Stack.Screen options={{ title: 'Cost' }} />
      <ErrorText error={error} />
      {!results && !error && <Loading label="Reading what it cost…" />}
      {cost && (
        <>
          <View style={styles.total}>
            <Text style={[Type.title, { color: theme.ink, fontVariant: ['tabular-nums'] }]}>{formatSpend(cost.totalUsd)}</Text>
            <Telemetry>{[cost.computeMs ? `${formatDuration(cost.computeMs)} of model time` : null, viaPlan && !viaApi ? 'on your Claude plan' : viaApi && !viaPlan ? 'on your API key' : viaPlan && viaApi ? 'plan and API key' : null].filter(Boolean).join('    ')}</Telemetry>
            {viaPlan && <Muted>On a plan this is what the same work would cost at API prices, not a charge.</Muted>}
          </View>
          {cost.byStage.length === 0 ? (
            <Muted>Nothing spent yet.</Muted>
          ) : (
            <Card style={styles.rows}>
              {cost.byStage.map((s, i) => (
                <View key={s.stage} style={[styles.row, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.line }]}>
                  <View style={styles.head}>
                    <View style={{ flex: 1 }}>
                      <Text style={[Type.body, { color: s.ok ? theme.ink : theme.failed }]}>{stageName(s.stage)}</Text>
                      {s.model ? <Telemetry>{modelName(s.model)}</Telemetry> : null}
                    </View>
                    <Telemetry style={styles.num}>{formatDuration(s.computeMs)}</Telemetry>
                    <Telemetry style={[styles.num, { color: theme.ink }]}>{formatSpend(s.costUsd)}</Telemetry>
                  </View>
                  <View style={[styles.track, { backgroundColor: theme.well }]}>
                    <View style={[styles.bar, { width: `${Math.max(2, (s.costUsd / most) * 100)}%`, backgroundColor: s.ok ? tint(theme.running, 0.7) : tint(theme.failed, 0.7) }]} />
                  </View>
                </View>
              ))}
            </Card>
          )}
        </>
      )}
    </Page>
  );
}

const styles = StyleSheet.create({
  total: { gap: Spacing.one },
  rows: { paddingVertical: Spacing.one, gap: 0 },
  row: { paddingVertical: 10, gap: 6 },
  head: { flexDirection: 'row', alignItems: 'baseline', gap: Spacing.three },
  num: { minWidth: 52, textAlign: 'right' },
  track: { height: 6, borderRadius: Radius.pill, overflow: 'hidden' },
  bar: { height: 6, borderRadius: Radius.pill },
});
