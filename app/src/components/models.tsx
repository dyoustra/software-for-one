import { useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import type { ModelChoices } from '@sfo/api';
import { Muted } from '@/components/ui';
import { Radius, Spacing, tint, Type } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

type Family = ModelChoices['thinking'];
const FAMILIES: { value: Family; name: string }[] = [
  { value: 'haiku', name: 'Haiku' },
  { value: 'sonnet', name: 'Sonnet' },
  { value: 'opus', name: 'Opus' },
];

const GROUPS: { key: 'thinking' | 'building' | 'writing'; name: string; what: string; stages: [string, string][] }[] = [
  {
    key: 'thinking',
    name: 'Thinking',
    what: 'Triage, research, spec, plan, review, rulings on tests',
    stages: [['triage', 'Triage'], ['research', 'Research'], ['spec', 'Spec'], ['plan', 'Plan'], ['review', 'Review'], ['adjudicate', 'Rulings on tests']],
  },
  {
    key: 'building',
    name: 'Building',
    what: 'Tests, building, smoke checks, your changes',
    stages: [['test-write', 'Writing tests'], ['test-repair', 'Setting up tests'], ['build', 'Building'], ['smoke', 'Smoke checks'], ['feedback', 'Your changes']],
  },
  { key: 'writing', name: 'Writing', what: 'Questions for you, the summary', stages: [['clarify', 'Questions for you'], ['deliver', 'Summary']] },
];

function Chips<T extends string>({ options, value, onChange }: { options: { value: T; name: string }[]; value: T; onChange: (v: T) => void }) {
  const theme = useTheme();
  return (
    <View style={styles.chips}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            onPress={() => onChange(o.value)}
            style={[styles.chip, on ? { borderColor: theme.accent, backgroundColor: tint(theme.accent, 0.12) } : { borderColor: theme.line }]}>
            <Text style={{ color: on ? theme.accent : theme.ink, fontWeight: '600' }}>{o.name}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * Which model family each part of a run uses (MODELS_SPEC): one choice per
 * group, a stronger model for retries, and per-stage choices for anyone who
 * wants them. Opus means the newest Opus, whichever that is.
 */
export function ModelPicker({ value, onChange }: { value: ModelChoices; onChange: (v: ModelChoices) => void }) {
  const theme = useTheme();
  const [byStage, setByStage] = useState(Object.keys(value.stages).length > 0);

  return (
    <View style={styles.picker}>
      {GROUPS.map((g) => (
        <View key={g.key} style={styles.group}>
          <Text style={[Type.body, { color: theme.ink, fontWeight: '600' }]}>{g.name}</Text>
          <Muted>{g.what}</Muted>
          <Chips options={FAMILIES} value={value[g.key]} onChange={(f) => onChange({ ...value, [g.key]: f })} />
        </View>
      ))}

      <View style={styles.toggle}>
        <Text style={[Type.body, { color: theme.ink, flex: 1 }]}>Retry with a stronger model</Text>
        <Switch value={value.escalate} onValueChange={(escalate) => onChange({ ...value, escalate })} />
      </View>

      <Pressable accessibilityRole="button" onPress={() => setByStage(!byStage)}>
        <Text style={[Type.label, { color: theme.accent }]}>{byStage ? 'Hide stage choices' : 'Choose by stage'}</Text>
      </Pressable>
      {byStage &&
        GROUPS.flatMap((g) =>
          g.stages.map(([stage, name]) => (
            <View key={stage} style={styles.group}>
              <Muted>{name}</Muted>
              <Chips
                options={[{ value: 'group' as const, name: `As ${g.name.toLowerCase()}` }, ...FAMILIES]}
                value={value.stages[stage] ?? 'group'}
                onChange={(f) => {
                  const stages = { ...value.stages };
                  if (f === 'group') delete stages[stage];
                  else stages[stage] = f;
                  onChange({ ...value, stages });
                }}
              />
            </View>
          )),
        )}
    </View>
  );
}

const styles = StyleSheet.create({
  picker: { gap: Spacing.three },
  group: { gap: 6 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two },
  chip: { borderRadius: Radius.pill, borderWidth: 1, paddingVertical: Spacing.two, paddingHorizontal: Spacing.three },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
});
