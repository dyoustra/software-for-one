import { NativeTabs } from 'expo-router/unstable-native-tabs';

export default function Tabs() {
  return (
    <NativeTabs>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>Projects</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="square.stack.3d.up" md="apps" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="new">
        <NativeTabs.Trigger.Label>New idea</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="plus.bubble" md="add" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings">
        <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="gearshape" md="settings" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
