import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Screen } from '@/components/screen';
import { supabase } from '@/lib/supabase';
import { colors } from '@/theme';

type QueueKind = 'followups' | 'tasks';
type QueueRow = {
  id: string;
  title: string;
  detail: string;
  dueAt: string | null;
  status: string;
  priority: string;
};
const pageSize = 25;

function dateTime(value: string | null) {
  if (!value) return 'No due date';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'No due date'
    : new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function priorityTone(priority: string) {
  if (priority === 'URGENT' || priority === 'HIGH') return '#dc2626';
  if (priority === 'NORMAL') return '#d97706';
  return '#2563eb';
}

export function MobileWorkQueueScreen({ kind }: { kind: QueueKind }) {
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const load = useCallback(
    async (nextPage: number) => {
      setLoading(true);
      setError(false);
      const from = (nextPage - 1) * pageSize;
      const to = nextPage * pageSize;
      if (kind === 'followups') {
        const { data, error: requestError } = await supabase
          .from('followups')
          .select('id,reason,due_at,status,priority')
          .in('status', ['OPEN', 'OVERDUE'])
          .order('due_at', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to);
        if (requestError) {
          setError(true);
          setLoading(false);
          return;
        }
        const response = (data ?? []) as Array<{
          id: string;
          reason: string;
          due_at: string;
          status: string;
          priority: string;
        }>;
        setRows(
          response.slice(0, pageSize).map((item) => ({
            id: item.id,
            title: item.reason,
            detail: 'Customer follow-up',
            dueAt: item.due_at,
            status: item.status,
            priority: item.priority,
          })),
        );
        setHasMore(response.length > pageSize);
      } else {
        const { data, error: requestError } = await supabase
          .from('tasks')
          .select('id,title,description,due_at,status,priority')
          .is('deleted_at', null)
          .in('status', ['OPEN', 'IN_PROGRESS'])
          .order('due_at', { ascending: true, nullsFirst: false })
          .order('id', { ascending: true })
          .range(from, to);
        if (requestError) {
          setError(true);
          setLoading(false);
          return;
        }
        const response = (data ?? []) as Array<{
          id: string;
          title: string;
          description: string | null;
          due_at: string | null;
          status: string;
          priority: string;
        }>;
        setRows(
          response.slice(0, pageSize).map((item) => ({
            id: item.id,
            title: item.title,
            detail: item.description ?? 'CRM task',
            dueAt: item.due_at,
            status: item.status,
            priority: item.priority,
          })),
        );
        setHasMore(response.length > pageSize);
      }
      setPage(nextPage);
      setLoading(false);
    },
    [kind],
  );
  useEffect(() => {
    void load(1);
  }, [load]);
  const title = kind === 'followups' ? 'Follow-ups' : 'Tasks';
  const subtitle =
    kind === 'followups'
      ? 'Open commitments in your authorized queue'
      : 'Open tasks in your authorized queue';

  return (
    <Screen title={title} subtitle={subtitle}>
      {loading ? (
        <View style={styles.loading}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : null}
      {error ? (
        <Pressable style={styles.error} onPress={() => void load(page)}>
          <Text style={styles.errorTitle}>{title} could not load</Text>
          <Text style={styles.errorText}>Tap to retry with your current secure session.</Text>
        </Pressable>
      ) : null}
      {!loading && !error ? (
        <View style={styles.card}>
          {rows.length ? (
            rows.map((row) => (
              <View key={row.id} style={styles.row}>
                <View style={styles.main}>
                  <Text style={styles.title}>{row.title}</Text>
                  <Text style={styles.detail}>{row.detail}</Text>
                  <Text style={styles.due}>{dateTime(row.dueAt)}</Text>
                </View>
                <View style={styles.badges}>
                  <Text style={[styles.priority, { color: priorityTone(row.priority) }]}>
                    {row.priority}
                  </Text>
                  <Text style={styles.status}>{row.status.replace('_', ' ')}</Text>
                </View>
              </View>
            ))
          ) : (
            <Text style={styles.empty}>No open {kind} in your current scope.</Text>
          )}
        </View>
      ) : null}
      {!loading && !error ? (
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
            style={[styles.pageButton, !hasMore && styles.disabled]}
            disabled={!hasMore}
            onPress={() => void load(page + 1)}
          >
            <Text style={styles.pageText}>Next</Text>
          </Pressable>
        </View>
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
    gap: 10,
  },
  main: { flex: 1 },
  title: { color: colors.text, fontSize: 14, fontWeight: '800' },
  detail: { color: colors.muted, fontSize: 11, marginTop: 4 },
  due: { color: colors.primary, fontSize: 11, fontWeight: '700', marginTop: 5 },
  badges: { alignItems: 'flex-end', gap: 6 },
  priority: { fontSize: 10, fontWeight: '800' },
  status: { color: colors.muted, fontSize: 10, fontWeight: '700' },
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
