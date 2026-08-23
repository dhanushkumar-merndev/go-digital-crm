import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Screen } from '@/components/screen';
import { fetchMobileCalls, type MobileCallRecord } from '@/lib/calls';
import { colors } from '@/theme';

function duration(value: number | null) {
  if (value === null) return 'Duration unavailable';
  const minutes = Math.floor(value / 60);
  const seconds = value % 60;
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}

function dateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Time unavailable'
    : new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function initials(name: string | null) {
  return (name ?? 'Customer')
    .split(' ')
    .filter(Boolean)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

export function MobileCallListScreen() {
  const [records, setRecords] = useState<MobileCallRecord[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const load = useCallback(async (nextPage: number) => {
    setLoading(true);
    setError(false);
    try {
      const result = await fetchMobileCalls(nextPage);
      setRecords(result.records);
      setTotal(result.total);
      setPage(nextPage);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load(1);
  }, [load]);

  return (
    <Screen title="Calls" subtitle="Your authorized call history">
      {loading ? (
        <View style={styles.loading}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : null}
      {error ? (
        <Pressable style={styles.error} onPress={() => void load(page)}>
          <Text style={styles.errorTitle}>Calls could not load</Text>
          <Text style={styles.errorText}>Tap to retry with your current secure session.</Text>
        </Pressable>
      ) : null}
      {!loading && !error ? (
        <>
          <Text style={styles.count}>
            {total} call{total === 1 ? '' : 's'} in your current scope
          </Text>
          <View style={styles.card}>
            {records.length ? (
              records.map((call) => (
                <Pressable
                  key={call.id}
                  style={styles.row}
                  onPress={() => router.push({ pathname: '/call/[id]', params: { id: call.id } })}
                >
                  <View style={styles.avatar}>
                    <Text style={styles.avatarText}>{initials(call.customer_name)}</Text>
                  </View>
                  <View style={styles.main}>
                    <Text style={styles.name}>{call.customer_name ?? 'Restricted party'}</Text>
                    <Text style={styles.meta}>
                      {call.phone ?? call.direction} · {duration(call.duration_seconds)}
                    </Text>
                    <Text style={styles.time}>{dateTime(call.started_at)}</Text>
                  </View>
                  <View style={styles.statuses}>
                    <Text style={styles.status}>
                      {(call.outcome ?? call.status).replaceAll('_', ' ')}
                    </Text>
                    {call.ai_summary_available ? <Text style={styles.ai}>AI summary</Text> : null}
                  </View>
                </Pressable>
              ))
            ) : (
              <Text style={styles.empty}>No calls are available in your current scope.</Text>
            )}
          </View>
          <View style={styles.pagination}>
            <Pressable
              style={[styles.pageButton, page === 1 && styles.disabled]}
              disabled={page === 1}
              onPress={() => void load(page - 1)}
            >
              <Text style={styles.pageText}>Previous</Text>
            </Pressable>
            <Text style={styles.pageLabel}>Page {page}</Text>
            <Pressable
              style={[styles.pageButton, records.length < 25 && styles.disabled]}
              disabled={records.length < 25}
              onPress={() => void load(page + 1)}
            >
              <Text style={styles.pageText}>Next</Text>
            </Pressable>
          </View>
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
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
  count: { color: colors.muted, fontSize: 12, fontWeight: '700' },
  card: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 15,
    overflow: 'hidden',
  },
  row: {
    minHeight: 82,
    padding: 13,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#e8f0ff',
  },
  avatarText: { color: colors.primary, fontWeight: '800' },
  main: { flex: 1 },
  name: { color: colors.text, fontSize: 14, fontWeight: '800' },
  meta: { color: colors.muted, fontSize: 11, marginTop: 3 },
  time: { color: colors.primary, fontSize: 10, fontWeight: '700', marginTop: 5 },
  statuses: { alignItems: 'flex-end', gap: 5, maxWidth: 88 },
  status: { color: colors.success, fontSize: 10, fontWeight: '800', textAlign: 'right' },
  ai: { color: '#7c3aed', fontSize: 10, fontWeight: '800' },
  empty: { color: colors.muted, fontSize: 12, textAlign: 'center', padding: 24 },
  pagination: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  pageButton: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    paddingHorizontal: 13,
    paddingVertical: 9,
    borderRadius: 10,
  },
  disabled: { opacity: 0.45 },
  pageText: { color: colors.primary, fontSize: 12, fontWeight: '800' },
  pageLabel: { color: colors.muted, fontSize: 12, fontWeight: '700' },
});
