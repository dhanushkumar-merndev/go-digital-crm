import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LeadRow } from '@/components/lead-row';
import { Card, ErrorState, SectionHeader, SkeletonList } from '@/components/ui/basics';
import { useWorkRefresh } from '@/features/call-flow/call-flow';
import { CallNext, KpiTiles, TodayHeader } from '@/features/today/today-parts';
import {
  fetchMobileTelecallerDashboard,
  type MobileTelecallerDashboard,
} from '@/lib/telecaller-dashboard';
import { colors, space } from '@/theme';

export default function Home() {
  const [dashboard, setDashboard] = useState<MobileTelecallerDashboard>();
  const [error, setError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [version, setVersion] = useState(0);
  const load = useCallback(async () => {
    setError(false);
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
        {dashboard?.recentLeads.length ? (
          <View style={styles.section}>
            <SectionHeader
              title="Recent leads"
              action="See all"
              onAction={() => router.push('/telecaller/my-leads')}
            />
            <Card>
              {dashboard.recentLeads.slice(0, 5).map((lead, index) => (
                <View key={lead.id} style={index > 0 ? styles.divider : undefined}>
                  <LeadRow
                    lead={{
                      id: lead.id,
                      name: lead.customerName,
                      phone: lead.phone,
                      model: lead.interestedModel,
                      source: lead.source,
                      stage: lead.lifecycleStatus,
                      temperature: lead.temperature,
                      nextFollowupAt: null,
                    }}
                  />
                </View>
              ))}
            </Card>
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  content: { padding: space.lg, paddingBottom: 40, gap: space.lg },
  section: { gap: space.sm },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
});
