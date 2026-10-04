import * as AppleAuthentication from 'expo-apple-authentication';
import { useEffect, useState } from 'react';
import { StyleSheet, useColorScheme, View } from 'react-native';

import { Body, ErrorText, Heading, Muted } from '@/components/ui';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useAuth } from '@/lib/auth';

export default function SignIn() {
  const { signIn } = useAuth();
  const theme = useTheme();
  const scheme = useColorScheme();
  const [available, setAvailable] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    AppleAuthentication.isAvailableAsync().then(setAvailable);
  }, []);

  return (
    <View style={[styles.screen, { backgroundColor: theme.background }]}>
      <View style={styles.column}>
        <Heading>Software For One</Heading>
        <Body>Say what you want built. sfo builds it in the cloud, asks when it needs you, and tells you when it is done.</Body>
        {available ? (
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
        ) : (
          <Muted>Sign in with Apple is not available on this device.</Muted>
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
