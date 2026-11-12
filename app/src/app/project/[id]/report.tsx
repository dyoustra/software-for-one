import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { Report } from '@sfo/api';
import { Badge, Card, Code, ErrorText, Muted, Page, Telemetry } from '@/components/ui';
import { Fonts, Radius, Spacing, Type } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useAuth } from '@/lib/auth';
import { inline, parseCriteria, parseDecisions, parseMarkdown, type Block, type Inline } from '@/lib/reports';

const TITLES: Record<string, string> = { summary: 'Summary', cost: 'Cost', decisions: 'Decisions', criteria: 'Criteria', slices: 'Slices', logs: 'Current log' };

export default function ReportScreen() {
  const { id, kind } = useLocalSearchParams<{ id: string; kind: string }>();
  const { api } = useAuth();
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api<Report>(kind === 'summary' ? `/projects/${id}/summary` : `/projects/${id}/report/${kind}`).then(setReport, setError);
  }, [api, id, kind]);

  const text = report?.output.trim() ?? '';
  return (
    <Page>
      <Stack.Screen options={{ title: TITLES[kind] ?? 'Report' }} />
      <ErrorText error={error} />
      {report && (text ? <Rendered kind={kind} text={text} /> : <Muted>Nothing yet.</Muted>)}
    </Page>
  );
}

/** Prose reports as typography; logs, cost and anything unrecognised as the text it is. */
function Rendered({ kind, text }: { kind: string; text: string }) {
  if (kind === 'summary') return <Prose blocks={parseMarkdown(text)} />;
  if (kind === 'decisions') {
    const decisions = parseDecisions(text);
    if (decisions) return <Decisions decisions={decisions} />;
  }
  if (kind === 'criteria') {
    const groups = parseCriteria(text);
    if (groups) return <Criteria groups={groups} />;
  }
  return <Code>{text}</Code>;
}

function Runs({ runs, style }: { runs: Inline[]; style?: object }) {
  const theme = useTheme();
  return (
    <Text selectable style={[Type.body, { color: theme.ink }, style]}>
      {runs.map((r, i) =>
        r.style === 'code' ? (
          <Text key={i} style={{ fontFamily: Fonts.mono }}>
            {r.text}
          </Text>
        ) : (
          <Text key={i} style={r.style === 'strong' ? styles.strong : undefined}>
            {r.text}
          </Text>
        ),
      )}
    </Text>
  );
}

function Prose({ blocks }: { blocks: Block[] }) {
  const theme = useTheme();
  return (
    <View style={styles.prose}>
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'heading':
            return <Runs key={i} runs={b.text} style={[b.level === 1 ? Type.title : styles.h2, { marginTop: i === 0 ? 0 : Spacing.three }]} />;
          case 'paragraph':
            return <Runs key={i} runs={b.text} />;
          case 'code':
            return <Code key={i}>{b.text}</Code>;
          case 'list':
            return (
              <View key={i} style={styles.list}>
                {b.items.map((item, j) => (
                  <View key={j} style={styles.item}>
                    <Text style={[Type.body, styles.marker, { color: theme.inkMuted }]}>{b.ordered ? `${j + 1}.` : '•'}</Text>
                    <Runs runs={item} style={{ flex: 1 }} />
                  </View>
                ))}
              </View>
            );
        }
      })}
    </View>
  );
}

function Decisions({ decisions }: { decisions: NonNullable<ReturnType<typeof parseDecisions>> }) {
  const theme = useTheme();
  return (
    <>
      {decisions.map((d) => (
        <Card key={d.id}>
          <View style={styles.decisionHead}>
            <Telemetry>{d.id}</Telemetry>
            <Text style={[Type.cardTitle, { color: theme.ink, flex: 1 }]}>{d.title}</Text>
            {d.byHuman && <Badge tone="done">You decided</Badge>}
          </View>
          <Text selectable style={[Type.body, { color: theme.ink }]}>
            {d.chose}
          </Text>
          {d.why ? <Muted>{d.why}</Muted> : null}
        </Card>
      ))}
    </>
  );
}

function Criteria({ groups }: { groups: NonNullable<ReturnType<typeof parseCriteria>> }) {
  const theme = useTheme();
  return (
    <>
      {groups.map((g) => (
        <View key={g.name || 'criteria'} style={styles.group}>
          {g.name ? <Text style={[styles.h2, { color: theme.ink }]}>{g.name}</Text> : null}
          <Card style={styles.rows}>
            {g.items.map((c, i) => (
              <View key={c.id} style={[styles.criterion, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.line }]}>
                <Telemetry style={styles.criterionId}>{c.id}</Telemetry>
                <Runs runs={inline(c.text)} style={[Type.body, styles.criterionText]} />
              </View>
            ))}
          </Card>
        </View>
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  prose: { gap: Spacing.three },
  h2: { fontSize: 19, lineHeight: 24, fontWeight: '600' },
  strong: { fontWeight: '600' },
  list: { gap: Spacing.two },
  item: { flexDirection: 'row', gap: Spacing.two },
  marker: { minWidth: 16 },
  decisionHead: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  group: { gap: Spacing.two },
  rows: { paddingVertical: 0, gap: 0, borderRadius: Radius.card },
  criterion: { flexDirection: 'row', gap: Spacing.three, paddingVertical: 12 },
  criterionId: { width: 56, paddingTop: 3 },
  criterionText: { flex: 1, fontSize: 15 },
});
