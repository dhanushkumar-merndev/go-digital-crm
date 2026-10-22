import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Card, ErrorState, SectionHeader, SkeletonList } from '@/components/ui/basics';
import { Icon, type IconName } from '@/components/ui/icon';
import { PressableScale } from '@/components/ui/pressable-scale';
import { RowPressable } from '@/components/ui/row';
import { SwipeRow } from '@/components/swipe-row';
import { useCallFlow, useWorkRefresh } from '@/features/call-flow/call-flow';
import {
  CallNext,
  KpiTiles,
  QuickActions,
  RecentLeadsStrip,
  TargetsCard,
  TodayHeader,
} from '@/features/today/today-parts';
import { fetchMobileSalesDashboard, type MobileSalesDashboard } from '@/lib/sales-dashboard';
import { getTestDriveTrackingState } from '@/lib/test-drive-tracking';
import { fetchTodayTargets, type TodayTarget } from '@/lib/today-targets';
import { colors, font, radius, space } from '@/theme';

type ScheduleKind = MobileSalesDashboard['schedule'][number]['kind'];

const scheduleLook: Record<ScheduleKind, { icon: IconName; label: string; tone: string }> = {
  FOLLOW_UP: { icon: 'alarm', label: 'Follow-up', tone: colors.warning },
  SHOWROOM_VISIT: { icon: 'storefront', label: 'Visit', tone: '#4338ca' },
  TEST_DRIVE: { icon: 'car-sport', label: 'Test drive', tone: colors.violetStrong },
  DELIVERY: { icon: 'gift', label: 'Delivery', tone: colors.success },
};

function clock(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit' }).format(date);
}

export default function Home() {
  const { call } = useCallFlow();
  const [dashboard, setDashboard] = useState<MobileSalesDashboard>();
  const [error, setError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [version, setVersion] = useState(0);
  const [driveActive, setDriveActive] = useState(false);
  const [targets, setTargets] = useState<TodayTarget[]>();
  const load = useCallback(async () => {
    setError(false);
    void fetchTodayTargets('sales')
      .then(setTargets)
      .catch(() => setTargets(undefined));
    try {
      setDashboard(await fetchMobileSalesDashboard());
    } catch {
      setError(true);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useWorkRefresh(() => void load());
  useFocusEffect(
    useCallback(() => {
      void getTestDriveTrackingState()
        .then((state) => setDriveActive(Boolean(state)))
        .catch(() => setDriveActive(false));
    }, []),
  );
  const refresh = async () => {
    setRefreshing(true);
    setVersion((current) => current + 1);
    await load();
    setRefreshing(false);
  };
  const target = Math.min(100, Math.max(0, dashboard?.metrics.targetAchievement ?? 0));
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
        <TodayHeader role="sales" />
        {driveActive ? (
          <Animated.View entering={FadeInDown.duration(220)}>
            <PressableScale onPress={() => router.push('/sales/test-drives')} style={styles.live}>
              <View style={styles.liveDot} />
              <View style={styles.grow}>
                <Text style={styles.liveTitle}>Test drive in progress</Text>
                <Text style={styles.liveText}>GPS is recording on this phone</Text>
              </View>
              <Icon name="chevron-forward" size={20} color="#fff" />
            </PressableScale>
          </Animated.View>
        ) : null}
        {error && !dashboard ? (
          <ErrorState title="Today could not load" onRetry={() => void load()} />
        ) : null}
        {!dashboard && !error ? <SkeletonList rows={3} /> : null}
        <TargetsCard items={targets} />
        <QuickActions
          items={[
            { label: 'Add lead', icon: 'add', tone: colors.primary, href: '/new-lead' },
            {
              label: 'Test drive',
              icon: 'car-sport',
              tone: colors.violetStrong,
              href: '/sales/test-drives',
            },
            { label: 'Schedule', icon: 'calendar', tone: colors.warning, href: '/sales/schedule' },
            { label: 'Stock', icon: 'cube', tone: '#0891b2', href: '/sales/stock-check' },
          ]}
        />
        {dashboard ? (
          <>
            {/* A month with no target configured reads 0%; show the count instead. */}
            <Card style={styles.target}>
              <View style={styles.targetTop}>
                <Text style={styles.targetLabel}>
                  {target > 0 ? 'Booking target' : 'Bookings this month'}
                </Text>
                <Text style={styles.targetValue}>
                  {target > 0 ? `${Math.round(target)}%` : dashboard.metrics.bookingsMonth}
                </Text>
              </View>
              {target > 0 ? (
                <>
                  <View style={styles.track}>
                    <View style={[styles.fill, { width: `${target}%` }]} />
                  </View>
                  <Text style={styles.targetMeta}>
                    {dashboard.metrics.bookingsMonth} bookings this month
                  </Text>
                </>
              ) : null}
            </Card>
            <KpiTiles
              items={[
                {
                  label: 'New today',
                  value: dashboard.metrics.leadsAssignedToday,
                  icon: 'sparkles',
                  tone: colors.primary,
                  href: '/sales/my-leads',
                },
                {
                  label: 'Due today',
                  value: dashboard.metrics.followupsToday,
                  icon: 'alarm',
                  tone: colors.warning,
                  href: '/sales/schedule',
                },
                {
                  label: 'Drives today',
                  value: dashboard.metrics.testDrivesToday,
                  icon: 'car-sport',
                  tone: colors.violetStrong,
                  href: { pathname: '/sales/schedule', params: { view: 'drives' } },
                },
                {
                  label: 'Hot leads',
                  value: dashboard.metrics.hotLeads,
                  icon: 'flame',
                  tone: colors.danger,
                  href: '/sales/my-leads',
                },
              ]}
            />
            {dashboard.schedule.length ? (
              <View style={styles.section}>
                <SectionHeader
                  title="Up next"
                  action="Schedule"
                  onAction={() => router.push('/sales/schedule')}
                />
                <Card>
                  {dashboard.schedule.slice(0, 6).map((item, index) => {
                    const look = scheduleLook[item.kind];
                    // Earlier items stay for context but step back visually.
                    const past = new Date(item.scheduledAt).getTime() < Date.now();
                    const phone = item.phone;
                    const startCall = phone
                      ? () =>
                          call({
                            leadId: item.leadId,
                            phone,
                            name: item.customerName || 'Customer',
                          })
                      : undefined;
                    return (
                      // Swipe right to call, the same gesture as Call next.
                      <View
                        key={`${item.kind}:${item.id}`}
                        style={index > 0 ? styles.divider : undefined}
                      >
                        <SwipeRow
                          left={
                            startCall
                              ? {
                                  label: 'Call',
                                  icon: 'call',
                                  color: colors.success,
                                  onTrigger: startCall,
                                }
                              : undefined
                          }
                        >
                          {/* Faded past rows sit on a solid layer, so the Call panel stays hidden until a swipe. */}
                          <View style={styles.opaque}>
                            <RowPressable
                              disabled={!item.leadId}
                              onPress={() =>
                                item.leadId &&
                                router.push({ pathname: '/lead/[id]', params: { id: item.leadId } })
                              }
                              style={past ? styles.past : undefined}
                            >
                              <Text style={styles.slotTime}>{clock(item.scheduledAt)}</Text>
                              <Icon name={look.icon} size={16} color={look.tone} />
                              <View style={styles.grow}>
                                <Text style={styles.slotName} numberOfLines={1}>
                                  {item.customerName || look.label}
                                </Text>
                                <Text style={styles.slotMeta} numberOfLines={1}>
                                  {[look.label, item.detail].filter(Boolean).join(' · ')}
                                </Text>
                              </View>
                              {item.leadId ? (
                                <Icon name="chevron-forward" size={18} color={colors.faint} />
                              ) : null}
                            </RowPressable>
                          </View>
                        </SwipeRow>
                      </View>
                    );
                  })}
                </Card>
              </View>
            ) : null}
          </>
        ) : null}
        <CallNext key={version} followupsHref="/sales/schedule" />
        {dashboard ? (
          <RecentLeadsStrip
            href="/sales/my-leads"
            leads={dashboard.recentLeads.slice(0, 8).map((lead) => ({
              id: lead.id,
              name: lead.customerName,
              phone: lead.phone,
              model: lead.interestedModel,
              source: lead.source,
              stage: lead.lifecycleStatus,
              temperature: lead.temperature,
              nextFollowupAt: lead.nextFollowupAt,
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
  grow: { flex: 1 },
  section: { gap: space.sm },
  live: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.violetStrong,
  },
  liveDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: '#4ade80' },
  liveTitle: { color: colors.onColor, fontSize: font.body, fontWeight: '600' },
  liveText: { color: '#ede9fe', fontSize: font.small, marginTop: 2 },
  target: { padding: space.lg, gap: space.sm },
  targetTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  targetLabel: { color: colors.muted, fontSize: font.small, fontWeight: '500' },
  targetValue: { color: colors.text, fontSize: font.display, fontWeight: '700' },
  track: { height: 6, borderRadius: 3, backgroundColor: '#eef1f6', overflow: 'hidden' },
  fill: { height: 6, borderRadius: 3, backgroundColor: colors.primary },
  targetMeta: { color: colors.muted, fontSize: font.label },
  past: { opacity: 0.5 },
  opaque: { backgroundColor: colors.card },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  slotTime: { width: 60, color: colors.text, fontSize: font.row, fontWeight: '600' },
  slotName: { color: colors.text, fontSize: font.body, fontWeight: '600' },
  slotMeta: { color: colors.muted, fontSize: font.small, marginTop: 2 },
});
