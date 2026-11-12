import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { CredentialKind, Device, Identity, LanguageKind, Preferences, PreferencesResponse } from '@sfo/api';
import { GitHubSignIn } from '@/components/github-sign-in';
import { Body, Button, Card, ErrorText, Field, Heading, Muted, Page, Telemetry } from '@/components/ui';
import { Radius, Spacing, tint, Type } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useAuth } from '@/lib/auth';
import { confirm } from '@/lib/confirm';

/** When a device last reached the control plane, as a short machine fact. */
function lastUsed(at: string): string {
  const days = Math.floor((Date.now() - Date.parse(at)) / 86_400_000);
  return days <= 0 ? 'today' : days === 1 ? '1d ago' : `${days}d ago`;
}

const PROVIDER_NAMES: Record<Identity['provider'], string> = { apple: 'Apple', github: 'GitHub' };

const KIND_NAMES: Record<LanguageKind, string> = { cli: 'Command-line tools', web: 'Web apps', mobile: 'Mobile apps', firmware: 'Firmware', default: 'Anything else' };

/** A row of choices, one selected. */
function Choice<T extends string>({ options, value, onChange }: { options: readonly T[]; value: T; onChange: (v: T) => void }) {
  const theme = useTheme();
  return (
    <View style={styles.choices}>
      {options.map((o) => (
        <Pressable
          key={o}
          accessibilityRole="radio"
          accessibilityState={{ checked: o === value }}
          onPress={() => onChange(o)}
          style={[styles.choice, o === value ? { borderColor: theme.accent, backgroundColor: tint(theme.accent, 0.12) } : { borderColor: theme.line }]}>
          <Text style={{ color: o === value ? theme.accent : theme.ink, fontWeight: '600' }}>{o}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export default function Settings() {
  const { api, signOut } = useAuth();
  const theme = useTheme();
  const [devices, setDevices] = useState<Device[]>([]);
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [linking, setLinking] = useState(false);
  const [have, setHave] = useState<CredentialKind[]>([]);
  const [prefs, setPrefs] = useState<PreferencesResponse | null>(null);
  const [rankings, setRankings] = useState<Record<string, string>>({});
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    try {
      const [d, i, c, p] = await Promise.all([
        api<Device[]>('/devices'),
        api<Identity[]>('/identities'),
        api<{ have: CredentialKind[] }>('/credentials'),
        api<PreferencesResponse>('/preferences'),
      ]);
      setDevices(d);
      setIdentities(i);
      setHave(c.have);
      setPrefs(p);
      setRankings(Object.fromEntries(Object.entries(p.preferences.languages).map(([k, v]) => [k, v.join(', ')])));
    } catch (err) {
      setError(err);
    }
  }, [api]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const set = (patch: Partial<Preferences>) => prefs && setPrefs({ ...prefs, preferences: { ...prefs.preferences, ...patch } });

  async function save() {
    if (!prefs) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const languages = Object.fromEntries(
        prefs.allowed.kinds.map((k) => [k, (rankings[k] ?? '').split(',').map((l) => l.trim().toLowerCase()).filter(Boolean)]),
      ) as Preferences['languages'];
      await api('/preferences', { method: 'PUT', body: { preferences: { ...prefs.preferences, languages }, sfoMd: prefs.sfoMd?.trim() ? prefs.sfoMd : null } });
      setSaved(true);
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  async function saveApiKey() {
    try {
      await api('/credentials/api-key', { method: 'PUT', body: { value: apiKey.trim() } });
      setApiKey('');
      await load();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <Page>
      <Heading>Settings</Heading>
      <ErrorText error={error} />

      <Card>
        <Body style={styles.section}>Paying for model calls</Body>
        <Muted>
          {have.includes('claude_token')
            ? 'Your Claude subscription is connected.'
            : 'No Claude subscription connected. Run `sfo login` on your Mac to bring it here.'}
        </Muted>
        <Muted>{have.includes('anthropic_api_key') ? 'An Anthropic API key is stored.' : 'No API key stored.'}</Muted>
        <Field placeholder="Paste an Anthropic API key" value={apiKey} onChangeText={setApiKey} autoCapitalize="none" autoCorrect={false} secureTextEntry />
        {apiKey.trim() ? <Button title="Save API key" kind="secondary" onPress={saveApiKey} /> : null}
      </Card>

      <Card>
        <Body style={styles.section}>GitHub</Body>
        <Muted>
          {have.includes('github_installation')
            ? 'Connected: each project gets a private repo, pushed after every stage.'
            : 'Not connected: projects build without a repo. Run `sfo login` on your Mac with a GitHub token in your profile.'}
        </Muted>
      </Card>

      {prefs && (
        <Card>
          <Body style={styles.section}>Preferences</Body>
          <Muted>Every new project reads these as guidance. A run that thinks something else is much better asks you first.</Muted>
          <Body>Languages, best first</Body>
          {prefs.allowed.kinds.map((k) => (
            <View key={k} style={styles.field}>
              <Muted>{KIND_NAMES[k]}</Muted>
              <Field value={rankings[k] ?? ''} onChangeText={(v) => setRankings({ ...rankings, [k]: v })} autoCapitalize="none" autoCorrect={false} />
            </View>
          ))}
          <Muted>Known: {prefs.allowed.languages.join(', ')}</Muted>
          <Body>Where web apps are published</Body>
          <Choice options={prefs.allowed.webHosts as Preferences['webHost'][]} value={prefs.preferences.webHost} onChange={(webHost) => set({ webHost })} />
          <Body>Where web app data lives</Body>
          <Choice options={prefs.allowed.webData as Preferences['webData'][]} value={prefs.preferences.webData} onChange={(webData) => set({ webData })} />
          <Body>Budget for each new project</Body>
          <Field
            placeholder="No limit"
            keyboardType="decimal-pad"
            value={prefs.preferences.budgetUsd === null ? '' : String(prefs.preferences.budgetUsd)}
            onChangeText={(v) => set({ budgetUsd: v.trim() ? Number(v) : null })}
          />
          <Body>Smoke checks may spend, per run</Body>
          <Field keyboardType="decimal-pad" value={String(prefs.preferences.smokeCapUsd)} onChangeText={(v) => set({ smokeCapUsd: Number(v) || 0 })} />
          <Body>SFO.md</Body>
          <Muted>Anything that fits no field above.</Muted>
          <Field multiline value={prefs.sfoMd ?? ''} onChangeText={(sfoMd) => setPrefs({ ...prefs, sfoMd })} />
          <Button title={saved ? 'Saved' : 'Save preferences'} onPress={save} busy={saving} />
        </Card>
      )}

      <Card>
        <Body style={styles.section}>Ways to sign in</Body>
        {identities.map((i) => (
          <Muted key={i.provider}>
            {PROVIDER_NAMES[i.provider]}, added {new Date(i.createdAt).toLocaleDateString()}
          </Muted>
        ))}
      </Card>
      {!identities.some((i) => i.provider === 'github') &&
        (linking ? (
          <GitHubSignIn
            link
            onDone={() => {
              setLinking(false);
              load();
            }}
            onCancel={() => setLinking(false)}
          />
        ) : (
          <Button title="Add Sign in with GitHub" kind="secondary" onPress={() => setLinking(true)} />
        ))}

      <Card>
        <Body style={styles.section}>Signed-in devices</Body>
        {devices.map((d) => (
          <View key={d.id} style={styles.row}>
            <Muted style={{ flex: 1 }}>
              {d.name}
              {d.current ? ' (this device)' : ''}
            </Muted>
            <Telemetry>{lastUsed(d.lastUsedAt ?? d.createdAt)}</Telemetry>
            {!d.current && (
              <Pressable
                onPress={async () => {
                  if (await confirm(`Sign out ${d.name}?`, 'It will need to sign in again.', 'Sign out')) api(`/devices/${d.id}`, { method: 'DELETE' }).then(load, setError);
                }}>
                <Text style={{ color: theme.failed, fontWeight: '600' }}>Revoke</Text>
              </Pressable>
            )}
          </View>
        ))}
        <Button title="Sign out of this device" kind="destructive" onPress={signOut} />
      </Card>
    </Page>
  );
}

const styles = StyleSheet.create({
  section: { ...Type.cardTitle },
  field: { gap: Spacing.one },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two },
  choice: { borderRadius: Radius.pill, borderWidth: 1, paddingVertical: Spacing.two, paddingHorizontal: Spacing.three },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two, paddingVertical: Spacing.one },
});
