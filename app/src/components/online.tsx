import { useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import type { Project } from '@sfo/api';
import { Button, Card, ErrorText, Field, Loading, Muted, Telemetry } from '@/components/ui';
import { Spacing, Type } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useAuth } from '@/lib/auth';
import { invalidate } from '@/lib/cache';

/**
 * Where a web project is online (WEB_AND_MOBILE_SPEC §4): its address, a way
 * to put a newer delivery up, and what to do when that cannot happen yet.
 */
export function Online({ project, onChange }: { project: Project; onChange: () => void }) {
  const theme = useTheme();
  const { api } = useAuth();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const p = project.publish;
  if (!p) return null;

  async function publish() {
    setBusy(true);
    setError(null);
    try {
      await api(`/projects/${project.id}/publish`, { method: 'POST' });
      invalidate(`/projects/${project.id}`);
      onChange();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      await api('/credentials/vercel', { method: 'PUT', body: { value: token.trim() } });
      setToken('');
      setBusy(false);
      await publish();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  if (p.state === 'deploying') return <Loading label="Going live on Vercel…" />;

  if (p.state === 'needs_connection') {
    return (
      <Card tone="waiting">
        <Text style={[Type.cardTitle, { color: theme.ink }]}>Connect Vercel to put it online</Text>
        <Muted>Create a token at vercel.com/account/tokens and paste it here. sfo keeps it encrypted and uses it only to publish your projects.</Muted>
        <Field placeholder="Vercel token" value={token} onChangeText={setToken} autoCapitalize="none" autoCorrect={false} secureTextEntry />
        <Button title="Connect and publish" busy={busy} disabled={!token.trim()} onPress={connect} />
        <ErrorText error={error} />
      </Card>
    );
  }

  return (
    <View style={styles.online}>
      {p.state === 'live' && p.url && (
        <Pressable accessibilityRole="link" onPress={() => /^https:\/\//.test(p.url ?? '') && Linking.openURL(p.url!)}>
          <Card style={styles.live}>
            <Text style={[Type.cardTitle, { color: theme.done }]}>Open it</Text>
            <Telemetry numberOfLines={1} style={{ color: theme.ink }}>
              {p.url.replace(/^https:\/\//, '')}
            </Telemetry>
          </Card>
        </Pressable>
      )}
      {p.state === 'failed' && (
        <Card>
          <Text style={[Type.cardTitle, { color: theme.failed }]}>It did not go online</Text>
          {p.error ? <Muted>{p.error}</Muted> : null}
        </Card>
      )}
      {(p.state === 'failed' || p.changed) && <Button title={p.state === 'failed' ? 'Try again' : 'Publish the new version'} busy={busy} onPress={publish} />}
      <ErrorText error={error} />
    </View>
  );
}

const styles = StyleSheet.create({
  online: { gap: Spacing.two },
  live: { gap: 4 },
});
