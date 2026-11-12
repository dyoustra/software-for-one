import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Card, Telemetry } from '@/components/ui';
import { Radius, Spacing, tint, Type } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import type { Row } from '@/lib/log';
import { groupCount, stageName, toRows } from '@/lib/log';
import { useLog } from '@/lib/use-log';

type Glyph = { ios: SymbolViewProps['name']; web: string; text: string };

/** An SF Symbol on iOS, a Material Symbol on the web, and a character if neither draws. */
const GLYPHS: Record<string, Glyph> = {
  read: { ios: 'doc.text', web: 'description', text: '◐' },
  edit: { ios: 'pencil', web: 'edit', text: '✎' },
  write: { ios: 'square.and.pencil', web: 'edit_note', text: '✎' },
  run: { ios: 'play.fill', web: 'play_arrow', text: '▶' },
  search: { ios: 'magnifyingglass', web: 'search', text: '⌕' },
  fetch: { ios: 'globe', web: 'language', text: '◍' },
  find: { ios: 'text.magnifyingglass', web: 'manage_search', text: '⌕' },
  tool: { ios: 'wrench.and.screwdriver', web: 'build', text: '⚙' },
  ok: { ios: 'checkmark', web: 'check', text: '✓' },
  failed: { ios: 'xmark', web: 'close', text: '✕' },
  alert: { ios: 'exclamationmark.triangle', web: 'warning', text: '!' },
};

function Icon({ glyph, color, background }: { glyph: Glyph; color: string; background: string }) {
  return (
    <View style={[styles.icon, { backgroundColor: background }]}>
      <SymbolView
        name={{ ios: glyph.ios, android: glyph.web, web: glyph.web } as SymbolViewProps['name']}
        size={14}
        tintColor={color}
        fallback={<Text style={{ color, fontSize: 13 }}>{glyph.text}</Text>}
      />
    </View>
  );
}

/** One row of the activity list: an icon for its kind, a verb, its target, and how it went. */
export function ActivityRow({ row }: { row: Row }) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);

  switch (row.kind) {
    case 'divider':
      return (
        <View style={styles.divider}>
          <View style={[styles.rule, { backgroundColor: theme.line }]} />
          <Telemetry tone={row.failed ? 'failed' : undefined}>{row.text}</Telemetry>
          <View style={[styles.rule, { backgroundColor: theme.line }]} />
        </View>
      );
    case 'say':
      return (
        <Pressable onPress={() => setOpen(!open)} accessibilityRole="button" accessibilityHint={open ? 'Shows less' : 'Shows all of it'}>
          <View style={[styles.quote, { borderLeftColor: theme.line }]}>
            <Text numberOfLines={open ? undefined : 2} style={[styles.quoteText, { color: theme.inkMuted }]}>
              {row.text}
            </Text>
          </View>
        </Pressable>
      );
    case 'note':
      return <Telemetry style={styles.note}>{row.text}</Telemetry>;
    case 'alert':
      return (
        <View style={styles.row}>
          <Icon glyph={GLYPHS.alert} color={theme[row.tone]} background={tint(theme[row.tone], 0.14)} />
          <Text style={[styles.alertText, { color: theme[row.tone] }]}>{row.text}</Text>
        </View>
      );
    case 'group':
      return (
        <Pressable onPress={() => setOpen(!open)} accessibilityRole="button">
          <View style={styles.row}>
            <Icon glyph={GLYPHS[row.action]} color={theme.inkMuted} background={theme.well} />
            <Text style={[styles.verb, { color: theme.ink }]}>{row.verb}</Text>
            <Telemetry style={styles.target}>{groupCount(row)}</Telemetry>
            <Text style={[Type.body, { color: theme.inkMuted }]}>{open ? '⌄' : '›'}</Text>
          </View>
          {open && (
            <View style={styles.groupItems}>
              {row.targets.map((t, i) => (
                <Telemetry key={i} numberOfLines={1}>
                  {t}
                </Telemetry>
              ))}
            </View>
          )}
        </Pressable>
      );
    case 'action': {
      const failed = row.status === 'failed';
      return (
        <View>
          <View style={styles.row}>
            <Icon glyph={GLYPHS[row.action]} color={failed ? theme.failed : theme.inkMuted} background={failed ? tint(theme.failed, 0.14) : theme.well} />
            <Text style={[styles.verb, { color: theme.ink }]}>{row.verb}</Text>
            <Telemetry numberOfLines={1} style={[styles.target, { color: theme.ink }]}>
              {row.target}
            </Telemetry>
            {row.status && (
              <SymbolView
                name={{ ios: GLYPHS[row.status].ios, android: GLYPHS[row.status].web, web: GLYPHS[row.status].web } as SymbolViewProps['name']}
                size={13}
                tintColor={failed ? theme.failed : theme.done}
                fallback={<Text style={{ color: failed ? theme.failed : theme.done }}>{GLYPHS[row.status].text}</Text>}
              />
            )}
          </View>
          {row.error && (
            <Telemetry tone="failed" numberOfLines={2} style={styles.error}>
              {row.error}
            </Telemetry>
          )}
        </View>
      );
    }
  }
}

/** Rows on a surface, hairlines between them. */
export function ActivityList({ rows }: { rows: Row[] }) {
  const theme = useTheme();
  return (
    <Card style={styles.list}>
      {rows.map((r, i) => (
        <View key={r.key} style={[styles.item, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.line }]}>
          <ActivityRow row={r} />
        </View>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  list: { paddingVertical: Spacing.one, gap: 0 },
  item: { paddingVertical: 9 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  icon: { width: 26, height: 26, borderRadius: Radius.pill, alignItems: 'center', justifyContent: 'center' },
  verb: { fontSize: 15, fontWeight: '600' },
  target: { flex: 1, fontSize: 13 },
  error: { marginLeft: 36, marginTop: 4 },
  quote: { borderLeftWidth: 2, paddingLeft: 12, marginLeft: 12 },
  quoteText: { fontSize: 15, lineHeight: 21, fontStyle: 'italic' },
  note: { paddingLeft: 36 },
  alertText: { flex: 1, fontSize: 14, lineHeight: 19 },
  divider: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  rule: { flex: 1, height: StyleSheet.hairlineWidth },
  groupItems: { marginLeft: 36, marginTop: 6, gap: 4 },
  stripHead: { flexDirection: 'row', paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth },
});

/**
 * The last few things a working run did, on its detail screen: proof it is
 * alive at a glance, and a way into the full log.
 */
export function LiveStrip({ projectId, onOpen }: { projectId: string; onOpen: () => void }) {
  const theme = useTheme();
  const { current, logs } = useLog(projectId, true);
  const rows = current ? toRows(logs[current]?.events ?? []).filter((r) => r.kind !== 'divider') : [];
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Open the full activity log" onPress={onOpen}>
      <Card style={styles.list}>
        <View style={[styles.stripHead, { borderBottomColor: theme.line }]}>
          <Text style={[Type.label, { color: theme.running, flex: 1 }]}>{current ? `Now: ${stageName(current)}` : 'Starting…'}</Text>
          <Text style={[Type.label, { color: theme.inkMuted }]}>All activity ›</Text>
        </View>
        {rows.slice(-3).map((r) => (
          <View key={r.key} style={styles.item}>
            <ActivityRow row={r} />
          </View>
        ))}
      </Card>
    </Pressable>
  );
}
