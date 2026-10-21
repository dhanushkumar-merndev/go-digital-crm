import { Tabs } from 'expo-router';
import { SquishyTabBar, tabScreenOptions, type TabSpec } from '@/components/tab-bar';

const tabs: TabSpec[] = [
  { name: 'home', label: 'Today', icon: 'sunny-outline', activeIcon: 'sunny' },
  { name: 'my-leads', label: 'Leads', icon: 'people-outline', activeIcon: 'people' },
  { name: 'follow-ups', label: 'Follow-ups', icon: 'alarm-outline', activeIcon: 'alarm' },
  { name: 'tasks', label: 'Tasks', icon: 'checkbox-outline', activeIcon: 'checkbox' },
];

export default function TelecallerTabs() {
  return (
    <Tabs
      tabBar={(props) => <SquishyTabBar {...props} tabs={tabs} />}
      // All four tabs mount once so a switch never shows an unpainted frame (the
      // native window showed through as a blue flash). Hidden tabs are frozen,
      // and useWorkRefresh reloads them on focus.
      screenOptions={tabScreenOptions}
    >
      <Tabs.Screen name="home" />
      <Tabs.Screen name="my-leads" />
      <Tabs.Screen name="follow-ups" />
      <Tabs.Screen name="tasks" />
      <Tabs.Screen name="calls" options={{ href: null }} />
    </Tabs>
  );
}
