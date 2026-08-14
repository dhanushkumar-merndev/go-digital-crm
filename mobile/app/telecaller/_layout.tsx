import { Tabs } from 'expo-router';
import { colors } from '@/theme';

export default function TelecallerTabs() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.muted,
        tabBarStyle: { height: 66, paddingBottom: 8, paddingTop: 7 },
      }}
    >
      <Tabs.Screen name="home" options={{ title: 'Home' }} />
      <Tabs.Screen name="my-leads" options={{ title: 'My Leads' }} />
      <Tabs.Screen name="follow-ups" options={{ title: 'Follow-ups' }} />
      <Tabs.Screen name="tasks" options={{ title: 'Tasks' }} />
    </Tabs>
  );
}
