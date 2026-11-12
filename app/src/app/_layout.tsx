import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { useColorScheme } from 'react-native';

import { Colors } from '@/constants/theme';
import { AuthProvider, useAuth } from '@/lib/auth';
import { followNotificationTaps, registerForPush } from '@/lib/push';

SplashScreen.preventAutoHideAsync();

/** React Navigation's stock themes, on sfo's surfaces: headers, modals and tab bars match the screens. */
const navigationTheme = (dark: boolean) => {
  const base = dark ? DarkTheme : DefaultTheme;
  const c = Colors[dark ? 'dark' : 'light'];
  return { ...base, colors: { ...base.colors, primary: c.accent, background: c.canvas, card: c.canvas, text: c.ink, border: c.line, notification: c.waiting } };
};

function Routes() {
  const { token, api } = useAuth();

  useEffect(() => {
    if (token !== undefined) SplashScreen.hideAsync();
  }, [token]);

  // Once signed in: this phone can be told when a run needs the person, and a
  // tap on that opens the project.
  useEffect(() => {
    if (!token) return;
    registerForPush(api).catch(() => undefined);
    return followNotificationTaps();
  }, [token, api]);

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
    <ThemeProvider value={navigationTheme(scheme === 'dark')}>
      <AuthProvider>
        <Routes />
      </AuthProvider>
    </ThemeProvider>
  );
}
