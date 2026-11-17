import * as AppleAuthentication from 'expo-apple-authentication';
import { useEffect, useState } from 'react';
import { StyleSheet, useColorScheme, View } from 'react-native';

import { GitHubSignIn } from '@/components/github-sign-in';
import { Body, Button, ErrorText, Heading } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { appleOnWeb } from '@/lib/apple-web';
import { useAuth } from '@/lib/auth';
import { passkeysHere } from '@/lib/passkeys';

export default function SignIn() {
  const { signIn, passkey } = useAuth();
  const theme = useTheme();
  const scheme = useColorScheme();
  const [available, setAvailable] = useState(appleOnWeb);
  const [error, setError] = useState<unknown>(null);
  const [withGitHub, setWithGitHub] = useState(false);

  useEffect(() => {
    if (!appleOnWeb()) AppleAuthentication.isAvailableAsync().then(setAvailable);
  }, []);

  return (
    <View style={[styles.screen, { backgroundColor: theme.canvas }]}>
      <View style={styles.column}>
        <Heading>Software For One</Heading>
        <Body>Say what you want built. sfo builds it in the cloud, asks when it needs you, and tells you when it is done.</Body>
        {available && !withGitHub && appleOnWeb() && (
          <Button
            title="Sign in with Apple"
            onPress={() => {
              setError(null);
              signIn().catch((err: { error?: string }) => {
                if (err?.error !== 'popup_closed_by_user') setError(err);
              });
            }}
          />
        )}
        {available && !withGitHub && !appleOnWeb() && (
          <AppleAuthentication.AppleAuthenticationButton
            buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
            buttonStyle={scheme === 'dark' ? AppleAuthentication.AppleAuthenticationButtonStyle.WHITE : AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
            cornerRadius={12}
            style={styles.button}
            onPress={() => {
              setError(null);
              signIn().catch((err: { code?: string }) => {
                if (err?.code !== 'ERR_REQUEST_CANCELED') setError(err);
              });
            }}
          />
        )}
        {passkeysHere() && !withGitHub && (
          <Button
            title="Sign in with a passkey"
            kind="secondary"
            onPress={() => {
              setError(null);
              passkey().catch((err: { code?: string; name?: string }) => {
                if (err?.name !== 'NotAllowedError' && err?.code !== 'ERR_CANCELED') setError(err);
              });
            }}
          />
        )}
        {withGitHub ? (
          <GitHubSignIn onCancel={() => setWithGitHub(false)} />
        ) : (
          <Button title="Sign in with GitHub" kind={available ? 'secondary' : 'primary'} onPress={() => setWithGitHub(true)} />
        )}
        <ErrorText error={error} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, justifyContent: 'center', padding: Spacing.four },
  column: { gap: Spacing.three, maxWidth: 420, width: '100%', alignSelf: 'center' },
  button: { height: 50, marginTop: Spacing.three },
});
