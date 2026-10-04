import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { useColorScheme } from 'react-native';

import { AuthProvider, useAuth } from '@/lib/auth';

SplashScreen.preventAutoHideAsync();

function Routes() {
  const { token } = useAuth();

  useEffect(() => {
    if (token !== undefined) SplashScreen.hideAsync();
  }, [token]);

  // The splash screen stays up until the stored token has been read.
  if (token === undefined) return null;

  return (
    <Stack>
      <Stack.Protected guard={!!token}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="project/[id]/index" options={{ title: 'Project', headerBackTitle: 'Projects' }} />
        <Stack.Screen name="project/[id]/questions" options={{ title: 'Questions', presentation: 'modal' }} />
        <Stack.Screen name="project/[id]/report" options={{ title: 'Report' }} />
      </Stack.Protected>
      <Stack.Protected guard={!token}>
        <Stack.Screen name="sign-in" options={{ headerShown: false }} />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  const scheme = useColorScheme();
  return (
    <ThemeProvider value={scheme === 'dark' ? DarkTheme : DefaultTheme}>
      <AuthProvider>
        <Routes />
      </AuthProvider>
    </ThemeProvider>
  );
}
