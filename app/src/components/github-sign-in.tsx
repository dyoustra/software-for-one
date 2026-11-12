import * as WebBrowser from 'expo-web-browser';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, View } from 'react-native';

import { Button, Card, ErrorText, Muted } from '@/components/ui';
import { Fonts, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useAuth, type GitHubCode } from '@/lib/auth';

/**
 * GitHub's code to enter at github.com/login/device, and a wait until it is
 * approved. Mounting it starts the flow; unmounting abandons it.
 */
export function GitHubSignIn({ link, onDone, onCancel }: { link?: boolean; onDone?: () => void; onCancel: () => void }) {
  const { gitHub } = useAuth();
  const theme = useTheme();
  const [code, setCode] = useState<GitHubCode | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    const abort = new AbortController();
    gitHub({ link, onCode: setCode, signal: abort.signal }).then(
      () => {
        if (Platform.OS === 'ios') WebBrowser.dismissBrowser();
        onDone?.();
      },
      (err) => {
        if (!abort.signal.aborted) setError(err);
      },
    );
    return () => abort.abort();
    // Once per mount: a new flow each time would show a new code.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function open() {
    if (!code) return;
    // On the web the code goes to the clipboard; on iOS the code stays on
    // screen (long-press copies it) and GitHub opens over it.
    if (Platform.OS === 'web') navigator.clipboard?.writeText(code.userCode).catch(() => undefined);
    WebBrowser.openBrowserAsync(code.verificationUri);
  }

  return (
    <Card>
      {error ? (
        <ErrorText error={error} />
      ) : !code ? (
        <ActivityIndicator />
      ) : (
        <>
          <Muted>Enter this code on GitHub:</Muted>
          <Text selectable style={[styles.code, { color: theme.ink }]}>
            {code.userCode}
          </Text>
          <Button title={Platform.OS === 'web' ? 'Copy code and open GitHub' : 'Open GitHub'} onPress={open} />
          <View style={styles.waiting}>
            <ActivityIndicator size="small" />
            <Muted>Waiting for you to approve it on GitHub…</Muted>
          </View>
        </>
      )}
      <Button title={error ? 'Back' : 'Cancel'} kind="secondary" onPress={onCancel} />
    </Card>
  );
}

const styles = StyleSheet.create({
  code: { fontFamily: Fonts?.mono, fontSize: 32, fontWeight: '700', letterSpacing: 4, textAlign: 'center', paddingVertical: Spacing.two },
  waiting: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two, justifyContent: 'center', paddingVertical: Spacing.one },
});
