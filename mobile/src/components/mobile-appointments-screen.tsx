import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Screen } from '@/components/screen';
import { supabase } from '@/lib/supabase';
import { colors } from '@/theme';

type Appointment = {
  id: string;
  appointment_type: string;
  scheduled_at: string;
  status: string;
  notes: string | null;
  customer_name: string | null;
  interested_model: string | null;
};
type AppointmentTab = 'today' | 'upcoming' | 'completed';
const pageSize = 25;
const tabs: Array<{ value: AppointmentTab; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'completed', label: 'Completed' },
];

function time(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Schedule unavailable'
    : new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export function MobileAppointmentsScreen() {
  const [records, setRecords] = useState<Appointment[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [tab, setTab] = useState<AppointmentTab>('today');
  const requestSequence = useRef(0);
  const load = useCallback(
    async (nextPage: number) => {
      const requestId = ++requestSequence.current;
      setLoading(true);
      setError(false);
      // The web workspace RPC resolves the caller's scope once instead of
      // running the RLS checks on every appointment in the organization.
      const { data, error: requestError } = await supabase.rpc('get_appointment_workspace_page', {
        target_status: tab,
        target_page: nextPage,
        target_page_size: pageSize,
        target_sort: tab === 'completed' ? 'scheduled:desc' : 'scheduled:asc',
        target_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata',
      });
      if (requestId !== requestSequence.current) return;
      if (requestError || !data) {
        setError(true);
        setLoading(false);
        return;
      }
      const result = data as { records?: Appointment[] | null; total?: number | null };
      setRecords(result.records ?? []);
      setHasMore(nextPage * pageSize < Number(result.total ?? 0));
      setPage(nextPage);
      setLoading(false);
    },
    [tab],
  );
  useEffect(() => {
    void load(1);
  }, [load]);
  return (
    <Screen title="Appointments" subtitle="Customer visits in your authorized scope">
      <View style={styles.tabs}>
        {tabs.map((item) => {
          const selected = tab === item.value;
          return (
            <Pressable
              key={item.value}
              style={[styles.tab, selected && styles.tabSelected]}
              onPress={() => setTab(item.value)}
              accessibilityRole="button"
              accessibilityState={{ selected }}
            >
              <Text style={[styles.tabText, selected && styles.tabTextSelected]}>{item.label}</Text>
            </Pressable>
          );
        })}
      </View>
      {loading ? (
        <View style={styles.loading}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : null}
      {error ? (
        <Pressable style={styles.error} onPress={() => void load(page)}>
          <Text style={styles.errorTitle}>Appointments could not load</Text>
          <Text style={styles.errorText}>Tap to retry with your current session.</Text>
        </Pressable>
      ) : null}
      {!loading && !error ? (
        <View style={styles.card}>
          {records.length ? (
            records.map((record) => (
              <View key={record.id} style={styles.row}>
                <View style={styles.main}>
                  <Text style={styles.title}>
                    {record.customer_name || record.appointment_type.replaceAll('_', ' ')}
                  </Text>
                  <Text style={styles.notes}>
                    {[record.appointment_type.replaceAll('_', ' '), record.interested_model]
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>
                  <Text style={styles.time}>{time(record.scheduled_at)}</Text>
                  {record.notes ? (
                    <Text numberOfLines={2} style={styles.notes}>
                      {record.notes}
                    </Text>
                  ) : null}
                </View>
                <Text style={styles.status}>{record.status.replaceAll('_', ' ')}</Text>
              </View>
            ))
          ) : (
            <Text style={styles.empty}>No {tab} appointments in your current scope.</Text>
          )}
        </View>
      ) : null}
      {!loading && !error ? (
        <View style={styles.pagination}>
          <Pressable
            style={[styles.button, page === 1 && styles.disabled]}
            disabled={page === 1}
            onPress={() => void load(page - 1)}
          >
            <Text style={styles.buttonText}>Previous</Text>
          </Pressable>
          <Text style={styles.page}>Page {page}</Text>
          <Pressable
            style={[styles.button, !hasMore && styles.disabled]}
            disabled={!hasMore}
            onPress={() => void load(page + 1)}
          >
            <Text style={styles.buttonText}>Next</Text>
          </Pressable>
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  tabs: { flexDirection: 'row', gap: 8 },
  tab: {
    flex: 1,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    borderRadius: 999,
    paddingVertical: 8,
  },
  tabSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  tabText: { color: colors.text, fontSize: 12, fontWeight: '700' },
  tabTextSelected: { color: '#ffffff' },
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
  card: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 15,
    overflow: 'hidden',
  },
  row: {
    minHeight: 75,
    padding: 13,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    flexDirection: 'row',
    gap: 10,
  },
  main: { flex: 1 },
  title: { color: colors.text, fontSize: 14, fontWeight: '800' },
  time: { color: colors.primary, fontSize: 11, fontWeight: '700', marginTop: 4 },
  notes: { color: colors.muted, fontSize: 11, marginTop: 4 },
  status: {
    color: colors.muted,
    fontSize: 10,
    fontWeight: '800',
    maxWidth: 80,
    textAlign: 'right',
  },
  empty: { color: colors.muted, fontSize: 12, textAlign: 'center', padding: 24 },
  pagination: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  button: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    paddingHorizontal: 13,
    paddingVertical: 9,
    borderRadius: 10,
  },
  disabled: { opacity: 0.45 },
  buttonText: { color: colors.primary, fontSize: 12, fontWeight: '800' },
  page: { color: colors.muted, fontSize: 12, fontWeight: '700' },
});
