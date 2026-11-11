import { Tabs } from 'expo-router';

import { useTheme } from '@/hooks/use-theme';

/**
 * The web build's tabs: a plain tab bar in the page's flow. NativeTabs on the
 * web floats its bar over the top of each screen, covering the heading.
 */
export default function WebTabs() {
  const theme = useTheme();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.accent,
        tabBarInactiveTintColor: theme.textSecondary,
        tabBarStyle: { backgroundColor: theme.background, borderTopColor: theme.backgroundSelected },
        tabBarIconStyle: { display: 'none' },
        tabBarLabelStyle: { fontSize: 15, fontWeight: '600' },
      }}>
      <Tabs.Screen name="index" options={{ title: 'Projects' }} />
      <Tabs.Screen name="new" options={{ title: 'New idea' }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings' }} />
    </Tabs>
  );
}
