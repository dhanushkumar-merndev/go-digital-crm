import { Tabs } from 'expo-router';
import { SquishyTabBar, tabScreenOptions, type TabSpec } from '@/components/tab-bar';

const tabs: TabSpec[] = [
  { name: 'home', label: 'Today', icon: 'sunny-outline', activeIcon: 'sunny' },
  { name: 'my-leads', label: 'Leads', icon: 'people-outline', activeIcon: 'people' },
  { name: 'schedule', label: 'Schedule', icon: 'calendar-outline', activeIcon: 'calendar' },
  { name: 'tasks', label: 'Tasks', icon: 'checkbox-outline', activeIcon: 'checkbox' },
];

// Follow-ups, visits and test drives live under Schedule; their old routes stay
// reachable so links from Today and saved deep links keep working.
export default function SalesTabs() {
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
      <Tabs.Screen name="schedule" />
      <Tabs.Screen name="tasks" />
      <Tabs.Screen name="follow-ups" options={{ href: null }} />
      <Tabs.Screen name="appointments" options={{ href: null }} />
      <Tabs.Screen name="test-drives" options={{ href: null }} />
      <Tabs.Screen name="calls" options={{ href: null }} />
      <Tabs.Screen name="stock-check" options={{ href: null }} />
    </Tabs>
  );
}
