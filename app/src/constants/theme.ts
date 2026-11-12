import { Platform, type TextStyle } from 'react-native';

/**
 * THEME_SPEC §3. Neutrals carry everything; each hue means a state. Light-mode
 * state colours are darker so text in them keeps 4.5:1 on `surface`.
 */
export const Colors = {
  light: {
    canvas: '#F4F6F9',
    surface: '#FFFFFF',
    /** Inputs and unselected choices: a step into the surface. */
    well: '#EDF0F4',
    line: '#D9DFE7',
    ink: '#111821',
    inkMuted: '#5A6576',
    running: '#2E5BDB',
    waiting: '#9A5F00',
    done: '#1D8452',
    failed: '#C93532',
    /** The primary action's colour, and what sits on it. */
    accent: '#2E5BDB',
    onAccent: '#FFFFFF',
  },
  dark: {
    canvas: '#0E131A',
    surface: '#151B24',
    well: '#1C2430',
    line: '#263040',
    ink: '#E7ECF3',
    inkMuted: '#8A95A7',
    running: '#4D7CFF',
    waiting: '#F3A73A',
    done: '#3DBA7E',
    failed: '#F0605D',
    accent: '#4D7CFF',
    onAccent: '#FFFFFF',
  },
} as const;

export type Theme = (typeof Colors)['light'];
export type Tone = 'running' | 'waiting' | 'done' | 'failed';

/** A state colour at the given opacity: badge fills (~0.14) and borders (~0.35). */
export function tint(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export const Fonts = Platform.select({
  ios: { sans: 'system-ui', mono: 'ui-monospace' },
  web: {
    sans: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    mono: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace',
  },
  default: { sans: 'normal', mono: 'monospace' },
});

/** The type scale. Prose is sans; machine facts are `telemetry`, with tabular figures. */
export const Type = {
  prompt: { fontSize: 34, lineHeight: 40, fontWeight: '600', letterSpacing: -0.7 },
  title: { fontSize: 28, lineHeight: 34, fontWeight: '700', letterSpacing: -0.4 },
  cardTitle: { fontSize: 17, lineHeight: 22, fontWeight: '600' },
  body: { fontSize: 16, lineHeight: 23 },
  label: { fontSize: 13, lineHeight: 17, fontWeight: '500' },
  telemetry: { fontSize: 13, lineHeight: 17, fontFamily: Fonts.mono, fontVariant: ['tabular-nums'] },
} satisfies Record<string, TextStyle>;

export const Radius = { card: 16, control: 12, pill: 999 } as const;

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

export const MaxContentWidth = 640;
