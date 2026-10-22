import { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ErrorState, SkeletonList } from '@/components/ui/basics';
import { useWorkRefresh } from '@/features/call-flow/call-flow';
import {
  CallNext,
  KpiTiles,
  QuickActions,
  RecentLeadsStrip,
  TargetsCard,
  TodayHeader,
} from '@/features/today/today-parts';
import {
  fetchMobileTelecallerDashboard,
  type MobileTelecallerDashboard,
} from '@/lib/telecaller-dashboard';
import { fetchTodayTargets, type TodayTarget } from '@/lib/today-targets';
import { colors, space } from '@/theme';

export default function Home() {
  const [dashboard, setDashboard] = useState<MobileTelecallerDashboard>();
  const [error, setError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [version, setVersion] = useState(0);
  const [targets, setTargets] = useState<TodayTarget[]>();
  const load = useCallback(async () => {
    setError(false);
    // Targets are optional decoration: they load beside the dashboard and a
    // failure only hides their card.
    void fetchTodayTargets('telecaller')
      .then(setTargets)
      .catch(() => setTargets(undefined));
    try {
      setDashboard(await fetchMobileTelecallerDashboard());
    } catch {
      setError(true);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useWorkRefresh(() => void load());
  const refresh = async () => {
    setRefreshing(true);
    setVersion((current) => current + 1);
    await load();
    setRefreshing(false);
  };
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void refresh()}
            colors={[colors.primary]}
          />
        }
      >
        <TodayHeader role="telecaller" />
        {error && !dashboard ? (
          <ErrorState title="Today could not load" onRetry={() => void load()} />
        ) : null}
        {!dashboard && !error ? <SkeletonList rows={3} /> : null}
        <TargetsCard items={targets} />
        <QuickActions
          items={[
            { label: 'Add lead', icon: 'add', tone: colors.primary, href: '/new-lead' },
            { label: 'My leads', icon: 'people', tone: '#0891b2', href: '/telecaller/my-leads' },
            {
              label: 'Follow-ups',
              icon: 'alarm',
              tone: colors.warning,
              href: '/telecaller/follow-ups',
            },
            { label: 'Call log', icon: 'call', tone: colors.success, href: '/telecaller/calls' },
          ]}
        />
        {dashboard ? (
          <KpiTiles
            items={[
              {
                label: 'New today',
                value: dashboard.kpis.newLeadsToday,
                icon: 'sparkles',
                tone: colors.primary,
                href: '/telecaller/my-leads',
              },
              {
                label: 'Due today',
                value: dashboard.kpis.followupsToday,
                icon: 'alarm',
                tone: colors.warning,
                href: '/telecaller/follow-ups',
              },
              {
                label: 'Overdue',
                value: dashboard.kpis.followupsOverdue,
                icon: 'alert-circle',
                tone: colors.danger,
                href: '/telecaller/follow-ups',
              },
              {
                label: 'Calls today',
                value: dashboard.kpis.callsToday,
                icon: 'call',
                tone: colors.success,
                href: '/telecaller/calls',
              },
            ]}
          />
        ) : null}
        <CallNext key={version} followupsHref="/telecaller/follow-ups" />
        {dashboard ? (
          <RecentLeadsStrip
            href="/telecaller/my-leads"
            leads={dashboard.recentLeads.slice(0, 8).map((lead) => ({
              id: lead.id,
              name: lead.customerName,
              phone: lead.phone,
              model: lead.interestedModel,
              source: lead.source,
              stage: lead.lifecycleStatus,
              temperature: lead.temperature,
              nextFollowupAt: null,
            }))}
          />
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  content: { padding: space.lg, paddingBottom: 40, gap: space.lg },
});
