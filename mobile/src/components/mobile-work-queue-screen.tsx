import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Screen } from '@/components/screen';
import { supabase } from '@/lib/supabase';
import { colors } from '@/theme';

type QueueKind = 'followups' | 'tasks';
type QueueTab = 'overdue' | 'today' | 'upcoming';
type QueueRow = {
  id: string;
  title: string;
  detail: string;
  dueAt: string | null;
  status: string;
  priority: string;
};
type QueueRecord = {
  id: string;
  customer_name: string | null;
  interested_model: string | null;
  reason?: string | null;
  title?: string | null;
  description?: string | null;
  due_at: string | null;
  status: string;
  display_status?: string | null;
  priority: string;
};
const pageSize = 25;
const tabs: Array<{ value: QueueTab; label: string }> = [
  { value: 'overdue', label: 'Overdue' },
  { value: 'today', label: 'Today' },
  { value: 'upcoming', label: 'Upcoming' },
];

function deviceTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata';
}

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

function toRow(kind: QueueKind, record: QueueRecord): QueueRow {
  const customer = [record.customer_name, record.interested_model].filter(Boolean).join(' · ');
  return kind === 'followups'
    ? {
        id: record.id,
        title: record.customer_name || 'Customer follow-up',
        detail: [record.reason, record.interested_model].filter(Boolean).join(' · '),
        dueAt: record.due_at,
        status: record.display_status ?? record.status,
        priority: record.priority,
      }
    : {
        id: record.id,
        title: record.title || 'CRM task',
        detail: customer || record.description || 'CRM task',
        dueAt: record.due_at,
        status: record.status,
        priority: record.priority,
      };
}

export function MobileWorkQueueScreen({ kind }: { kind: QueueKind }) {
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [tab, setTab] = useState<QueueTab>('overdue');
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const requestSequence = useRef(0);
  const load = useCallback(
    async (nextPage: number) => {
      const requestId = ++requestSequence.current;
      setLoading(true);
      setError(false);
      // The web workspace RPCs resolve the caller's scope once. Reading the
      // tables directly ran the RLS checks on every row in the organization;
      // follow-ups hit the 8 s statement timeout.
      const { data, error: requestError } =
        kind === 'followups'
          ? await supabase.rpc('get_followup_workspace_filtered_page', {
              target_status: tab,
              target_page: nextPage,
              target_page_size: pageSize,
              target_sort: 'scheduled:asc',
              target_timezone: deviceTimezone(),
            })
          : await supabase.rpc('get_task_workspace_page', {
              target_status: tab.toUpperCase(),
              target_page: nextPage,
              target_page_size: pageSize,
              target_sort: 'due:asc',
              target_timezone: deviceTimezone(),
            });
      if (requestId !== requestSequence.current) return;
      if (requestError || !data) {
        setError(true);
        setLoading(false);
        return;
      }
      const result = data as { records?: QueueRecord[] | null; total?: number | null };
      setRows((result.records ?? []).map((record) => toRow(kind, record)));
      setHasMore(nextPage * pageSize < Number(result.total ?? 0));
      setPage(nextPage);
      setLoading(false);
    },
    [kind, tab],
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
                  {row.detail ? <Text style={styles.detail}>{row.detail}</Text> : null}
                  <Text style={styles.due}>{dateTime(row.dueAt)}</Text>
                </View>
                <View style={styles.badges}>
                  <Text style={[styles.priority, { color: priorityTone(row.priority) }]}>
                    {row.priority}
                  </Text>
                  <Text style={styles.status}>{row.status.replaceAll('_', ' ')}</Text>
                </View>
              </View>
            ))
          ) : (
            <Text style={styles.empty}>
              No {tab} {kind === 'followups' ? 'follow-ups' : 'tasks'} in your current scope.
            </Text>
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
