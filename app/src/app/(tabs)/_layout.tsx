import { NativeTabs } from 'expo-router/unstable-native-tabs';

import { useTheme } from '@/hooks/use-theme';
import { useProjects } from '@/lib/projects';

export default function Tabs() {
  const theme = useTheme();
  const { waiting } = useProjects();
  return (
    <NativeTabs tintColor={theme.accent} badgeBackgroundColor={theme.waiting}>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>Idea</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="lightbulb" md="lightbulb" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="projects">
        <NativeTabs.Trigger.Label>Projects</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="square.stack.3d.up" md="apps" />
        <NativeTabs.Trigger.Badge hidden={waiting.length === 0}>{String(waiting.length)}</NativeTabs.Trigger.Badge>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings">
        <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="gearshape" md="settings" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
