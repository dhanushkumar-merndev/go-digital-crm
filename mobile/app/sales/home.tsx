import { router } from 'expo-router';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type DimensionValue,
} from 'react-native';
import { Screen } from '@/components/screen';
import { fetchMobileSalesDashboard, type MobileSalesDashboard } from '@/lib/sales-dashboard';
import { colors } from '@/theme';

function time(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit' }).format(date);
}

function temperatureColor(value: MobileSalesDashboard['recentLeads'][number]['temperature']) {
  if (value === 'HOT') return '#e11d48';
  if (value === 'WARM') return '#d97706';
  return '#2563eb';
}

function attentionLabel(key: string) {
  return key
    .toLowerCase()
    .split('_')
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function formatPercent(value: number) {
  return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}%`;
}

function progressWidth(value: number): DimensionValue {
  return `${Math.min(100, Math.max(0, value))}%`;
}

export default function Home() {
  const [dashboard, setDashboard] = useState<MobileSalesDashboard>();
  const [error, setError] = useState(false);
  const load = useCallback(async () => {
    setError(false);
    try {
      setDashboard(await fetchMobileSalesDashboard());
    } catch {
      setError(true);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Screen title="Sales Consultant" subtitle="Go Digital Marketing CRM">
      <View style={styles.hero}>
        <View style={styles.heroHeading}>
          <View>
            <Text style={styles.heroTitle}>Ready to close more deals?</Text>
            <Text style={styles.heroText}>Your live priorities are ready for today.</Text>
          </View>
          <View style={styles.dealerMark} accessibilityLabel="Dealership workspace">
            <Text style={styles.dealerMarkText}>GD</Text>
          </View>
        </View>
        {dashboard ? (
          <View style={styles.targetCard}>
            <View style={styles.targetHeading}>
              <Text style={styles.targetTitle}>Today&apos;s activity</Text>
              <Text style={styles.liveText}>Live</Text>
            </View>
            <View style={styles.targetGrid}>
              <TargetMetric
                label="Leads"
                value={dashboard.metrics.leadsAssignedToday}
                tone="#2563eb"
              />
              <TargetMetric
                label="Drives"
                value={dashboard.metrics.testDrivesToday}
                tone="#059669"
              />
              <TargetMetric
                label="Bookings MTD"
                value={dashboard.metrics.bookingsMonth}
                tone="#f97316"
              />
              <TargetMetric
                label="Calls due"
                value={dashboard.metrics.callsPending}
                tone="#7c3aed"
              />
            </View>
            <View style={styles.targetProgressHeader}>
              <Text style={styles.targetProgressLabel}>Booking target achievement</Text>
              <Text style={styles.targetProgressValue}>
                {formatPercent(dashboard.metrics.targetAchievement)}
              </Text>
            </View>
            <View style={styles.targetProgressTrack}>
              <View
                style={[
                  styles.targetProgressFill,
                  { width: progressWidth(dashboard.metrics.targetAchievement) },
                ]}
              />
            </View>
          </View>
        ) : null}
      </View>
      {!dashboard && !error ? (
        <View style={styles.loading}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : null}
      {error ? (
        <Pressable style={styles.error} onPress={() => void load()} accessibilityRole="button">
          <Text style={styles.errorTitle}>Dashboard could not load</Text>
          <Text style={styles.errorText}>Tap to retry with your current secure session.</Text>
        </Pressable>
      ) : null}
      {dashboard ? (
        <View style={styles.stack}>
          <View style={styles.quickCard}>
            <QuickAction
              glyph="◉"
              label="My leads"
              onPress={() => router.push('/sales/my-leads')}
            />
            <QuickAction glyph="☎" label="Calls" onPress={() => router.push('/sales/calls')} />
            <QuickAction
              glyph="◌"
              label="Follow-ups"
              onPress={() => router.push('/sales/follow-ups')}
            />
            <QuickAction
              glyph="▣"
              label="Appointments"
              onPress={() => router.push('/sales/appointments')}
            />
            <QuickAction
              glyph="▱"
              label="Test drive"
              onPress={() => router.push('/sales/test-drives')}
            />
            <QuickAction
              glyph="⌕"
              label="Check stock"
              onPress={() => router.push('/sales/stock-check')}
            />
          </View>

          <Section
            title="Today snapshot"
            action="View leads"
            onAction={() => router.push('/sales/my-leads')}
          >
            <View style={styles.snapshotGrid}>
              <Snapshot
                label="New leads"
                value={dashboard.metrics.leadsAssignedToday}
                tone="#2563eb"
              />
              <Snapshot
                label="Follow-ups"
                value={dashboard.metrics.followupsToday}
                tone="#d97706"
              />
              <Snapshot
                label="Test drives"
                value={dashboard.metrics.testDrivesToday}
                tone="#059669"
              />
              <Snapshot label="Hot leads" value={dashboard.metrics.hotLeads} tone="#e11d48" />
            </View>
          </Section>

          <Section
            title="Upcoming follow-ups"
            action="View all"
            onAction={() => router.push('/sales/follow-ups')}
          >
            {dashboard.schedule.length ? (
              dashboard.schedule.slice(0, 3).map((item) => (
                <Pressable
                  key={item.id}
                  style={styles.schedule}
                  onPress={() => router.push('/sales/appointments')}
                  accessibilityRole="button"
                >
                  <View style={styles.scheduleIcon}>
                    <Text style={styles.scheduleIconText}>▣</Text>
                  </View>
                  <View style={styles.scheduleMain}>
                    <Text style={styles.customer}>{item.customerName}</Text>
                    <Text numberOfLines={1} style={styles.meta}>
                      {item.kind.replace('_', ' ')}
                      {item.detail ? ` · ${item.detail}` : ''}
                    </Text>
                  </View>
                  <Text style={styles.time}>{time(item.scheduledAt)}</Text>
                </Pressable>
              ))
            ) : (
              <Empty text="No upcoming items today." />
            )}
          </Section>

          <Section
            title="Recent leads"
            action="View all"
            onAction={() => router.push('/sales/my-leads')}
          >
            {dashboard.recentLeads.length ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.leadScroller}
              >
                {dashboard.recentLeads.slice(0, 5).map((lead) => (
                  <Pressable
                    key={lead.id}
                    style={styles.leadTile}
                    onPress={() => router.push({ pathname: '/lead/[id]', params: { id: lead.id } })}
                    accessibilityRole="button"
                  >
                    <View
                      style={[
                        styles.avatar,
                        { backgroundColor: `${temperatureColor(lead.temperature)}18` },
                      ]}
                    >
                      <Text
                        style={[styles.avatarText, { color: temperatureColor(lead.temperature) }]}
                      >
                        {lead.customerName
                          .split(' ')
                          .map((part) => part[0])
                          .join('')
                          .slice(0, 2)}
                      </Text>
                    </View>
                    <Text numberOfLines={1} style={styles.customer}>
                      {lead.customerName}
                    </Text>
                    <Text numberOfLines={1} style={styles.meta}>
                      {lead.interestedModel ?? lead.source}
                    </Text>
                    <Text
                      style={[styles.temperature, { color: temperatureColor(lead.temperature) }]}
                    >
                      {lead.temperature ?? lead.lifecycleStatus}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            ) : (
              <Empty text="No recent leads in your assigned scope." />
            )}
          </Section>

          <Pressable
            style={styles.routeBanner}
            onPress={() => router.push('/sales/test-drives')}
            accessibilityRole="button"
          >
            <View>
              <Text style={styles.routeTitle}>Test-drive GPS</Text>
              <Text style={styles.routeText}>Start or resume a live route</Text>
            </View>
            <Text style={styles.routeArrow}>→</Text>
          </Pressable>

          <Section
            title="Requires attention"
            action="View leads"
            onAction={() => router.push('/sales/my-leads')}
          >
            {dashboard.attention.length ? (
              dashboard.attention.map((item) => (
                <View key={item.key} style={styles.attention}>
                  <Text style={styles.attentionLabel}>{attentionLabel(item.key)}</Text>
                  <Text style={styles.attentionValue}>{item.value}</Text>
                </View>
              ))
            ) : (
              <Empty text="No attention items right now." />
            )}
          </Section>
        </View>
      ) : null}
    </Screen>
  );
}

function TargetMetric({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <View style={styles.targetMetric}>
      <Text style={[styles.targetMetricValue, { color: tone }]}>{value}</Text>
      <Text numberOfLines={1} style={styles.targetMetricLabel}>
        {label}
      </Text>
    </View>
  );
}

function Snapshot({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <View style={styles.snapshot}>
      <Text style={[styles.snapshotValue, { color: tone }]}>{value}</Text>
      <Text numberOfLines={2} style={styles.snapshotLabel}>
        {label}
      </Text>
    </View>
  );
}

function QuickAction({
  glyph,
  label,
  onPress,
}: {
  glyph: string;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable style={styles.quickAction} onPress={onPress} accessibilityRole="button">
      <View style={styles.quickGlyph}>
        <Text style={styles.quickGlyphText}>{glyph}</Text>
      </View>
      <Text numberOfLines={1} style={styles.quickLabel}>
        {label}
      </Text>
    </Pressable>
  );
}

function Section({
  title,
  action,
  onAction,
  children,
}: {
  title: string;
  action: string;
  onAction: () => void;
  children: ReactNode;
}) {
  return (
    <View>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>{title}</Text>
        <Pressable onPress={onAction} accessibilityRole="button">
          <Text style={styles.link}>{action}</Text>
        </Pressable>
      </View>
      <View style={styles.card}>{children}</View>
    </View>
  );
}

function Empty({ text }: { text: string }) {
  return <Text style={styles.empty}>{text}</Text>;
}

const styles = StyleSheet.create({
  hero: { backgroundColor: '#142d73', borderRadius: 22, overflow: 'hidden' },
  heroHeading: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: 18,
    paddingBottom: 42,
  },
  heroTitle: { color: 'white', fontSize: 22, fontWeight: '800', maxWidth: 250 },
  heroText: { color: '#dbeafe', fontSize: 13, marginTop: 5 },
  dealerMark: {
    alignItems: 'center',
    backgroundColor: '#ffffff1f',
    borderColor: '#ffffff66',
    borderRadius: 22,
    borderWidth: 1,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  dealerMarkText: { color: 'white', fontSize: 13, fontWeight: '900' },
  targetCard: {
    backgroundColor: colors.card,
    borderColor: '#d9e5ff',
    borderRadius: 18,
    borderWidth: 1,
    marginHorizontal: 12,
    marginBottom: 12,
    marginTop: -28,
    padding: 12,
  },
  targetHeading: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  targetTitle: { color: colors.text, fontSize: 15, fontWeight: '800' },
  liveText: { color: colors.success, fontSize: 11, fontWeight: '800' },
  targetGrid: { flexDirection: 'row', gap: 7 },
  targetMetric: {
    alignItems: 'center',
    backgroundColor: '#f8fafc',
    borderRadius: 12,
    flex: 1,
    paddingHorizontal: 4,
    paddingVertical: 10,
  },
  targetMetricValue: { fontSize: 19, fontWeight: '900' },
  targetMetricLabel: { color: colors.text, fontSize: 9, fontWeight: '700', marginTop: 3 },
  targetProgressHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 12,
  },
  targetProgressLabel: { color: colors.muted, fontSize: 10, fontWeight: '700' },
  targetProgressValue: { color: colors.primary, fontSize: 11, fontWeight: '900' },
  targetProgressTrack: {
    backgroundColor: '#dbeafe',
    borderRadius: 999,
    height: 5,
    marginTop: 5,
    overflow: 'hidden',
  },
  targetProgressFill: { backgroundColor: colors.primary, borderRadius: 999, height: '100%' },
  loading: { alignItems: 'center', padding: 36 },
  error: {
    backgroundColor: '#fef2f2',
    borderColor: '#fecaca',
    borderRadius: 14,
    borderWidth: 1,
    padding: 16,
  },
  errorTitle: { color: '#991b1b', fontWeight: '800' },
  errorText: { color: '#b91c1c', fontSize: 12, marginTop: 4 },
  stack: { gap: 20 },
  quickCard: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingVertical: 10,
  },
  quickAction: { alignItems: 'center', paddingHorizontal: 5, paddingVertical: 8, width: '33.33%' },
  quickGlyph: {
    alignItems: 'center',
    backgroundColor: '#eff6ff',
    borderRadius: 22,
    height: 42,
    justifyContent: 'center',
    width: 42,
  },
  quickGlyphText: { color: colors.primary, fontSize: 22, fontWeight: '800' },
  quickLabel: {
    color: colors.text,
    fontSize: 10,
    fontWeight: '700',
    marginTop: 5,
    textAlign: 'center',
    width: '100%',
  },
  sectionHeader: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  sectionTitle: { color: colors.text, fontSize: 18, fontWeight: '800' },
  link: { color: colors.primary, fontSize: 12, fontWeight: '800' },
  card: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: 16,
    borderWidth: 1,
    marginTop: 9,
    overflow: 'hidden',
  },
  snapshotGrid: { flexDirection: 'row', padding: 9 },
  snapshot: {
    alignItems: 'center',
    backgroundColor: '#f8fafc',
    borderRadius: 12,
    flex: 1,
    marginHorizontal: 3,
    minHeight: 72,
    padding: 9,
  },
  snapshotValue: { fontSize: 19, fontWeight: '900' },
  snapshotLabel: {
    color: colors.muted,
    fontSize: 9,
    fontWeight: '700',
    marginTop: 4,
    textAlign: 'center',
  },
  schedule: {
    alignItems: 'center',
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 9,
    minHeight: 67,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  scheduleIcon: {
    alignItems: 'center',
    backgroundColor: '#f5f3ff',
    borderRadius: 16,
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  scheduleIconText: { color: '#7c3aed', fontSize: 15, fontWeight: '800' },
  scheduleMain: { flex: 1 },
  customer: { color: colors.text, fontSize: 13, fontWeight: '800' },
  meta: { color: colors.muted, fontSize: 11, marginTop: 3 },
  time: { color: colors.primary, fontSize: 11, fontWeight: '800' },
  leadScroller: { gap: 10, padding: 10 },
  leadTile: {
    backgroundColor: '#fff',
    borderColor: '#e6ebf2',
    borderRadius: 14,
    borderWidth: 1,
    minHeight: 126,
    padding: 11,
    width: 142,
  },
  avatar: {
    alignItems: 'center',
    borderRadius: 18,
    height: 36,
    justifyContent: 'center',
    marginBottom: 8,
    width: 36,
  },
  avatarText: { fontSize: 12, fontWeight: '800' },
  temperature: { fontSize: 10, fontWeight: '800', marginTop: 10 },
  routeBanner: {
    alignItems: 'center',
    backgroundColor: '#e0f2fe',
    borderColor: '#bae6fd',
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: 16,
  },
  routeTitle: { color: '#0f3c71', fontSize: 15, fontWeight: '800' },
  routeText: { color: '#2563eb', fontSize: 12, fontWeight: '700', marginTop: 3 },
  routeArrow: { color: '#2563eb', fontSize: 25, fontWeight: '800' },
  attention: {
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  attentionLabel: { color: colors.text, fontSize: 13, fontWeight: '700' },
  attentionValue: { color: colors.primary, fontSize: 15, fontWeight: '800' },
  empty: { color: colors.muted, fontSize: 12, padding: 18, textAlign: 'center' },
});
