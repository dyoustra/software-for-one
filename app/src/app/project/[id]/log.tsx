import { Stack, useLocalSearchParams } from 'expo-router';
import { useRef } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ActivityList } from '@/components/activity';
import { Button, ErrorText, Muted, Telemetry } from '@/components/ui';
import { MaxContentWidth, Spacing, Type } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { stageName, toRows } from '@/lib/log';
import { cardModel } from '@/lib/pipeline';
import { useProjects } from '@/lib/projects';
import { useLog } from '@/lib/use-log';

/** How close to the end still counts as "at the bottom", so the list keeps following. */
const FOLLOW_SLACK = 80;

function kb(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
}

/** A run's activity (LIVE_LOGS_SPEC §3): earlier stages on demand, then the live one, followed while it runs. */
export default function LogScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { projects } = useProjects();
  const theme = useTheme();
  const project = projects?.find((p) => p.id === id);
  const live = project ? cardModel(project).kind === 'running' : false;
  const { stages, current, logs, loadStage, error, loaded } = useLog(id, live);
  const scroll = useRef<ScrollView>(null);
  const following = useRef(true);

  const earlier = stages.filter((s) => s.name !== current);
  const now = current ? logs[current] : undefined;

  return (
    <ScrollView
      ref={scroll}
      style={{ backgroundColor: theme.canvas }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.page}
      scrollEventThrottle={100}
      onScroll={(e) => {
        const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
        following.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - FOLLOW_SLACK;
      }}
      onContentSizeChange={() => following.current && scroll.current?.scrollToEnd({ animated: true })}>
      <Stack.Screen options={{ title: 'Activity' }} />
      <View style={styles.column}>
        <ErrorText error={error} />
        {!loaded && <ActivityIndicator />}
        {loaded && stages.length === 0 && <Muted>Nothing yet. Activity shows here once the run starts.</Muted>}

        {earlier.map((s) => {
          const log = logs[s.name];
          return (
            <View key={s.name} style={styles.stage}>
              <Pressable accessibilityRole="button" disabled={!!log} onPress={() => loadStage(s.name)} style={styles.header}>
                <Text style={[Type.cardTitle, { color: log ? theme.ink : theme.inkMuted, flex: 1 }]}>{stageName(s.name)}</Text>
                {log?.loading ? <ActivityIndicator size="small" /> : !log && <Telemetry>{`${kb(s.size)}  ›`}</Telemetry>}
              </Pressable>
              {log && log.events.length > 0 && <ActivityList rows={toRows(log.events)} />}
              {log && !log.loading && log.to < s.size && <Button title="Show more" kind="secondary" onPress={() => loadStage(s.name)} />}
            </View>
          );
        })}

        {current && (
          <View style={styles.stage}>
            <View style={styles.header}>
              <Text style={[Type.cardTitle, { color: theme.ink, flex: 1 }]}>{stageName(current)}</Text>
              {live && <Telemetry tone="running">live</Telemetry>}
            </View>
            {now && now.events.length > 0 ? <ActivityList rows={toRows(now.events)} /> : <Muted>Starting…</Muted>}
          </View>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: Spacing.three, paddingBottom: Spacing.six, alignItems: 'center' },
  column: { width: '100%', maxWidth: MaxContentWidth, gap: Spacing.four },
  stage: { gap: Spacing.two },
  header: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two, minHeight: 28 },
});
