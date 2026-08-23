import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Screen } from '@/components/screen';
import {
  fetchMobileTelecallerDashboard,
  type MobileTelecallerDashboard,
} from '@/lib/telecaller-dashboard';
import { colors } from '@/theme';

function tone(temperature: MobileTelecallerDashboard['recentLeads'][number]['temperature']) {
  if (temperature === 'HOT') return '#dc2626';
  if (temperature === 'WARM') return '#d97706';
  return '#2563eb';
}

export default function Home() {
  const [dashboard, setDashboard] = useState<MobileTelecallerDashboard>();
  const [error, setError] = useState(false);
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
  return (
    <Screen title="Telecaller workspace" subtitle="Your live lead queue and commitments">
      <View style={styles.hero}>
        <Text style={styles.heroTitle}>Stay ahead of every enquiry</Text>
        <Text style={styles.heroText}>Prioritize the conversations that need you now.</Text>
      </View>
      {!dashboard && !error ? (
        <View style={styles.loading}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : null}
      {error ? (
        <Pressable style={styles.error} onPress={() => void load()}>
          <Text style={styles.errorTitle}>Workspace could not load</Text>
          <Text style={styles.errorText}>Tap to retry with your secure session.</Text>
        </Pressable>
      ) : null}
      {dashboard ? (
        <View style={styles.stack}>
          <View style={styles.metrics}>
            <Metric label="New today" value={dashboard.kpis.newLeadsToday} tone="#2563eb" />
            <Metric label="Open queue" value={dashboard.kpis.openLeads} tone="#4f46e5" />
            <Metric label="Follow-ups" value={dashboard.kpis.followupsToday} tone="#d97706" />
            <Metric label="Calls today" value={dashboard.kpis.callsToday} tone="#059669" />
          </View>
          <View style={styles.quick}>
            <Quick label="My leads" onPress={() => router.push('/telecaller/my-leads')} />
            <Quick label="Follow-ups" onPress={() => router.push('/telecaller/follow-ups')} />
            <Quick label="Calls" onPress={() => router.push('/telecaller/calls')} />
            <Quick label="Tasks" onPress={() => router.push('/telecaller/tasks')} />
          </View>
          <View>
            <View style={styles.heading}>
              <Text style={styles.title}>Needs attention</Text>
              <Text style={styles.small}>{dashboard.kpis.followupsOverdue} overdue</Text>
            </View>
            <View style={styles.card}>
              {dashboard.attention.length ? (
                dashboard.attention.map((item, index) => (
                  <View key={`${item.title}:${index}`} style={styles.attention}>
                    <View
                      style={[
                        styles.dot,
                        { backgroundColor: item.severity === 'HIGH' ? '#fee2e2' : '#fef3c7' },
                      ]}
                    />
                    <View style={styles.grow}>
                      <Text style={styles.customer}>{item.title}</Text>
                      <Text style={styles.meta}>{item.detail}</Text>
                    </View>
                    <Text
                      style={[
                        styles.severity,
                        { color: item.severity === 'HIGH' ? '#b91c1c' : '#b45309' },
                      ]}
                    >
                      {item.severity}
                    </Text>
                  </View>
                ))
              ) : (
                <Text style={styles.empty}>No attention items right now.</Text>
              )}
            </View>
          </View>
          <View>
            <View style={styles.heading}>
              <Text style={styles.title}>Recent leads</Text>
              <Pressable onPress={() => router.push('/telecaller/my-leads')}>
                <Text style={styles.link}>View all</Text>
              </Pressable>
            </View>
            <View style={styles.card}>
              {dashboard.recentLeads.length ? (
                dashboard.recentLeads.map((lead) => (
                  <Pressable
                    key={lead.id}
                    style={styles.lead}
                    onPress={() => router.push({ pathname: '/lead/[id]', params: { id: lead.id } })}
                  >
                    <View
                      style={[styles.avatar, { backgroundColor: `${tone(lead.temperature)}18` }]}
                    >
                      <Text style={[styles.avatarText, { color: tone(lead.temperature) }]}>
                        {lead.customerName
                          .split(' ')
                          .map((part) => part[0])
                          .join('')
                          .slice(0, 2)}
                      </Text>
                    </View>
                    <View style={styles.grow}>
                      <Text style={styles.customer}>{lead.customerName}</Text>
                      <Text style={styles.meta}>{lead.interestedModel ?? lead.source}</Text>
                    </View>
                    <Text style={[styles.severity, { color: tone(lead.temperature) }]}>
                      {lead.temperature ?? lead.lifecycleStatus}
                    </Text>
                  </Pressable>
                ))
              ) : (
                <Text style={styles.empty}>No leads in your assigned queue.</Text>
              )}
            </View>
          </View>
        </View>
      ) : null}
    </Screen>
  );
}

function Metric({ label, value, tone: color }: { label: string; value: number; tone: string }) {
  return (
    <View style={styles.metric}>
      <Text style={[styles.metricValue, { color }]}>{value}</Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </View>
  );
}
function Quick({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable style={styles.quickAction} onPress={onPress}>
      <Text style={styles.quickGlyph}>→</Text>
      <Text style={styles.quickLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  hero: { backgroundColor: '#173c93', borderRadius: 18, padding: 18 },
  heroTitle: { color: 'white', fontSize: 21, fontWeight: '800' },
  heroText: { color: '#dbeafe', fontSize: 13, marginTop: 5 },
  loading: { padding: 36, alignItems: 'center' },
  error: {
    borderColor: '#fecaca',
    borderWidth: 1,
    backgroundColor: '#fef2f2',
    borderRadius: 14,
    padding: 16,
  },
  errorTitle: { color: '#991b1b', fontWeight: '800' },
  errorText: { color: '#b91c1c', fontSize: 12, marginTop: 4 },
  stack: { gap: 18 },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  metric: {
    width: '48%',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: 14,
  },
  metricValue: { fontSize: 25, fontWeight: '800' },
  metricLabel: { color: colors.muted, fontSize: 11, fontWeight: '700', marginTop: 5 },
  quick: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    padding: 10,
    flexDirection: 'row',
    justifyContent: 'space-around',
  },
  quickAction: { alignItems: 'center', width: '24%', paddingVertical: 7 },
  quickGlyph: { color: colors.primary, fontSize: 22, fontWeight: '800' },
  quickLabel: { color: colors.text, fontSize: 10, fontWeight: '700', marginTop: 3 },
  heading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { color: colors.text, fontSize: 17, fontWeight: '800' },
  small: { color: colors.warning, fontWeight: '800', fontSize: 11 },
  link: { color: colors.primary, fontWeight: '800', fontSize: 12 },
  card: {
    marginTop: 9,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 15,
    overflow: 'hidden',
  },
  attention: {
    minHeight: 63,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  grow: { flex: 1 },
  customer: { color: colors.text, fontSize: 13, fontWeight: '800' },
  meta: { color: colors.muted, fontSize: 11, marginTop: 3 },
  severity: { maxWidth: 75, textAlign: 'right', fontSize: 10, fontWeight: '800' },
  lead: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { fontSize: 12, fontWeight: '800' },
  empty: { padding: 18, textAlign: 'center', color: colors.muted, fontSize: 12 },
});
