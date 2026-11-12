import { StyleSheet, Text, View } from 'react-native';
import Animated, { useReducedMotion } from 'react-native-reanimated';

import { tint, Type, type Tone } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { MILESTONES } from '@/lib/pipeline';

const HEIGHT = 36;
const DOT = 8;
const NODE = 16;
const HALO = 34;
const SLOT = 100 / MILESTONES.length;
const LABEL = 96;

/** The halo's one breath: a slow swell and fade, about 2.4 s each way round. */
const BREATH = {
  from: { opacity: 0.35, transform: [{ scale: 0.8 }] },
  to: { opacity: 0.95, transform: [{ scale: 1.12 }] },
};

/**
 * The pipeline as one line of seven milestones (THEME_SPEC §6): lit up to
 * where the run is, the current node enlarged and labeled, and haloed only
 * there. `at` of -1 lights nothing (a project still being set up).
 */
export function Rail({ at, tone, halo }: { at: number; tone: Tone; halo: 'breathing' | 'steady' | 'none' }) {
  const theme = useTheme();
  const still = useReducedMotion();
  const color = theme[tone];
  const span = 100 - SLOT;
  const label = at >= 0 ? MILESTONES[at] : null;

  return (
    <View accessible accessibilityLabel={label ? `At ${label}, step ${at + 1} of ${MILESTONES.length}` : 'Not started'}>
      <View style={styles.rail}>
        <View style={[styles.track, { left: `${SLOT / 2}%`, right: `${SLOT / 2}%`, backgroundColor: theme.line }]} />
        {at > 0 && <View style={[styles.track, { left: `${SLOT / 2}%`, width: `${(at / (MILESTONES.length - 1)) * span}%`, backgroundColor: color }]} />}
        {MILESTONES.map((m, i) => (
          <View key={m} style={styles.slot}>
            {i === at ? (
              <View style={styles.nodeBox}>
                {halo !== 'none' && (
                  <Animated.View
                    style={[
                      styles.halo,
                      { backgroundColor: tint(color, 0.28), boxShadow: `0 0 14px 4px ${tint(color, 0.55)}` },
                      halo === 'breathing' && !still
                        ? { animationName: BREATH, animationDuration: '2.4s', animationIterationCount: 'infinite', animationDirection: 'alternate', animationTimingFunction: 'ease-in-out' }
                        : { opacity: 0.8 },
                    ]}
                  />
                )}
                <View style={[styles.node, { borderColor: color, backgroundColor: theme.surface }]}>
                  <View style={[styles.core, { backgroundColor: color }]} />
                </View>
              </View>
            ) : (
              <View style={[styles.dot, { backgroundColor: i < at ? color : theme.line }]} />
            )}
          </View>
        ))}
      </View>
      {label && (
        // Placed absolutely: a label is wider than its slot, and centred under
        // its node except at the ends, where it aligns to the card's edge.
        <View style={styles.labels}>
          <Text
            numberOfLines={1}
            style={[
              Type.label,
              styles.label,
              { color },
              at === 0 ? { left: 0, textAlign: 'left' } : at === MILESTONES.length - 1 ? { right: 0, textAlign: 'right' } : { left: `${(at + 0.5) * SLOT}%`, marginLeft: -LABEL / 2, textAlign: 'center' },
            ]}>
            {label}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  rail: { height: HEIGHT, flexDirection: 'row', alignItems: 'center' },
  track: { position: 'absolute', height: 2, top: HEIGHT / 2 - 1, borderRadius: 1 },
  slot: { flex: 1, alignItems: 'center', justifyContent: 'center', overflow: 'visible' },
  dot: { width: DOT, height: DOT, borderRadius: DOT / 2 },
  nodeBox: { width: HALO, height: HALO, alignItems: 'center', justifyContent: 'center' },
  halo: { position: 'absolute', width: HALO, height: HALO, borderRadius: HALO / 2 },
  node: { width: NODE, height: NODE, borderRadius: NODE / 2, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  core: { width: 6, height: 6, borderRadius: 3 },
  labels: { height: 17, marginTop: -2 },
  label: { position: 'absolute', width: LABEL },
});
