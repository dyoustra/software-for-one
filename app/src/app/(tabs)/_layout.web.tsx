import { Tabs } from 'expo-router';

import { useTheme } from '@/hooks/use-theme';
import { useProjects } from '@/lib/projects';

/**
 * The web build's tabs: a plain tab bar in the page's flow. NativeTabs on the
 * web floats its bar over the top of each screen, covering the heading.
 */
export default function WebTabs() {
  const theme = useTheme();
  const { waiting } = useProjects();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.accent,
        tabBarInactiveTintColor: theme.inkMuted,
        tabBarStyle: { backgroundColor: theme.canvas, borderTopColor: theme.line },
        tabBarIconStyle: { display: 'none' },
        tabBarLabelStyle: { fontSize: 15, fontWeight: '600' },
      }}>
      <Tabs.Screen name="projects" options={{ title: 'Projects', tabBarBadge: waiting.length || undefined, tabBarBadgeStyle: { backgroundColor: theme.waiting, color: theme.canvas } }} />
      <Tabs.Screen name="index" options={{ title: 'Idea' }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings' }} />
    </Tabs>
  );
}
