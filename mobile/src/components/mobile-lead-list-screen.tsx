import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Screen } from '@/components/screen';
import { supabase } from '@/lib/supabase';
import { colors } from '@/theme';

type Lead = {
  id: string;
  customer_name: string;
  phone: string;
  source: string;
  interested_model: string | null;
  lifecycle_status: string;
  temperature: 'COLD' | 'WARM' | 'HOT' | 'DORMANT' | null;
  next_followup_at: string | null;
};

type LeadFilter = 'ALL' | 'HOT' | 'WARM' | 'COLD' | 'NEW';

const pageSize = 25;
const filters: Array<{ value: LeadFilter; label: string }> = [
  { value: 'ALL', label: 'All leads' },
  { value: 'HOT', label: 'Hot' },
  { value: 'WARM', label: 'Warm' },
  { value: 'COLD', label: 'Cold' },
  { value: 'NEW', label: 'New' },
];

function tone(value: Lead['temperature']) {
  if (value === 'HOT') return '#e11d48';
  if (value === 'WARM') return '#d97706';
  return '#2563eb';
}

function date(value: string | null) {
  if (!value) return 'Not scheduled';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? 'Not scheduled'
    : new Intl.DateTimeFormat('en-IN', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      }).format(parsed);
}

function safeSearch(value: string) {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9\s+-]/g, '')
    .slice(0, 80);
}

export function MobileLeadListScreen() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [filter, setFilter] = useState<LeadFilter>('ALL');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const requestSequence = useRef(0);
  const load = useCallback(
    async (nextPage: number) => {
      const requestId = ++requestSequence.current;
      setLoading(true);
      setError(false);
      const term = safeSearch(search);
      let request = supabase
        .from('leads')
        .select(
          'id,customer_name,phone,source,interested_model,lifecycle_status,temperature,next_followup_at',
          { count: 'exact' },
        )
        .is('deleted_at', null)
        .order('updated_at', { ascending: false })
        .order('id', { ascending: false })
        .range((nextPage - 1) * pageSize, nextPage * pageSize);
      if (filter === 'NEW') request = request.eq('lifecycle_status', 'New');
      if (filter === 'HOT' || filter === 'WARM' || filter === 'COLD')
        request = request.eq('temperature', filter);
      if (term) request = request.or(`customer_name.ilike.%${term}%,phone.ilike.%${term}%`);
      const { data, error: requestError, count } = await request;
      if (requestId !== requestSequence.current) return;
      if (requestError) {
        setError(true);
        setLoading(false);
        return;
      }
      setLeads(((data ?? []) as Lead[]).slice(0, pageSize));
      setTotal(count ?? 0);
      setPage(nextPage);
      setHasMore((data ?? []).length > pageSize);
      setLoading(false);
    },
    [filter, search],
  );
  useEffect(() => {
    const timer = setTimeout(() => void load(1), 300);
    return () => clearTimeout(timer);
  }, [load]);

  return (
    <Screen
      title="My Leads"
      subtitle={
        total
          ? `${total.toLocaleString()} lead${total === 1 ? '' : 's'} in your authorized scope`
          : 'Your authorized mobile lead queue'
      }
    >
      <View style={styles.searchRow}>
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search name or phone"
          placeholderTextColor={colors.muted}
          returnKeyType="search"
          onSubmitEditing={() => void load(1)}
          style={styles.search}
          accessibilityLabel="Search leads by customer name or phone"
        />
        <Pressable style={styles.refresh} onPress={() => void load(1)} accessibilityRole="button">
          <Text style={styles.refreshText}>↻</Text>
        </Pressable>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.filters}
      >
        {filters.map((item) => {
          const selected = filter === item.value;
          return (
            <Pressable
              key={item.value}
              style={[styles.filter, selected && styles.filterSelected]}
              onPress={() => setFilter(item.value)}
              accessibilityRole="button"
              accessibilityState={{ selected }}
            >
              <Text style={[styles.filterText, selected && styles.filterTextSelected]}>
                {item.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
      <View style={styles.sortRow}>
        <Text style={styles.sortText}>Sorted by: Last updated</Text>
        <Text style={styles.updatedText}>{loading ? 'Updating…' : 'Live'}</Text>
      </View>
      {loading ? (
        <View style={styles.loading}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : null}
      {error ? (
        <Pressable style={styles.error} onPress={() => void load(page)} accessibilityRole="button">
          <Text style={styles.errorTitle}>Leads could not load</Text>
          <Text style={styles.errorText}>Tap to retry with your current session.</Text>
        </Pressable>
      ) : null}
      {!loading && !error ? (
        <View style={styles.list}>
          {leads.length ? (
            leads.map((lead) => <LeadCard key={lead.id} lead={lead} />)
          ) : (
            <Text style={styles.empty}>No leads match this filter in your assigned queue.</Text>
          )}
        </View>
      ) : null}
      {!loading && !error ? (
        <View style={styles.pagination}>
          <Pressable
            disabled={page === 1}
            style={[styles.pageButton, page === 1 && styles.disabled]}
            onPress={() => void load(page - 1)}
            accessibilityRole="button"
          >
            <Text style={styles.pageText}>Previous</Text>
          </Pressable>
          <Text style={styles.pageLabel}>Page {page}</Text>
          <Pressable
            disabled={!hasMore}
            style={[styles.pageButton, !hasMore && styles.disabled]}
            onPress={() => void load(page + 1)}
            accessibilityRole="button"
          >
            <Text style={styles.pageText}>Next</Text>
          </Pressable>
        </View>
      ) : null}
    </Screen>
  );
}

function LeadCard({ lead }: { lead: Lead }) {
  const label = lead.temperature ?? lead.lifecycle_status;
  const color = tone(lead.temperature);
  return (
    <Pressable
      style={styles.lead}
      onPress={() => router.push({ pathname: '/lead/[id]', params: { id: lead.id } })}
      accessibilityRole="button"
    >
      <View style={styles.leadTop}>
        <View style={[styles.avatar, { backgroundColor: `${color}18` }]}>
          <Text style={[styles.avatarText, { color }]}>
            {lead.customer_name
              .split(' ')
              .map((part) => part[0])
              .join('')
              .slice(0, 2)}
          </Text>
        </View>
        <View style={styles.main}>
          <View style={styles.nameRow}>
            <Text numberOfLines={1} style={styles.customer}>
              {lead.customer_name}
            </Text>
            <View style={[styles.status, { backgroundColor: `${color}16` }]}>
              <Text style={[styles.statusText, { color }]}>{label}</Text>
            </View>
          </View>
          <Text numberOfLines={1} style={styles.model}>
            {lead.interested_model ?? lead.source}
          </Text>
          <Text style={styles.phone}>⌕ {lead.phone}</Text>
        </View>
        <Text style={styles.chevron}>›</Text>
      </View>
      <View style={styles.leadFooter}>
        <View>
          <Text style={styles.footerLabel}>Next follow-up</Text>
          <Text style={styles.footerValue}>{date(lead.next_followup_at)}</Text>
        </View>
        <View style={styles.footerDivider} />
        <View>
          <Text style={styles.footerLabel}>Lead source</Text>
          <Text numberOfLines={1} style={styles.footerValue}>
            {lead.source}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  searchRow: { flexDirection: 'row', gap: 9 },
  search: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: 13,
    borderWidth: 1,
    color: colors.text,
    flex: 1,
    fontSize: 13,
    height: 44,
    paddingHorizontal: 13,
  },
  refresh: {
    alignItems: 'center',
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: 13,
    borderWidth: 1,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  refreshText: { color: colors.primary, fontSize: 22, fontWeight: '800' },
  filters: { gap: 8, paddingVertical: 1 },
  filter: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 15,
    paddingVertical: 10,
  },
  filterSelected: { backgroundColor: '#eff6ff', borderColor: '#93c5fd' },
  filterText: { color: colors.text, fontSize: 12, fontWeight: '700' },
  filterTextSelected: { color: colors.primary },
  sortRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  sortText: { color: colors.text, fontSize: 12, fontWeight: '700' },
  updatedText: { color: colors.success, fontSize: 11, fontWeight: '800' },
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
  list: { gap: 12 },
  lead: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: 17,
    borderWidth: 1,
    padding: 13,
  },
  leadTop: { alignItems: 'center', flexDirection: 'row', gap: 11 },
  avatar: {
    alignItems: 'center',
    borderRadius: 27,
    height: 54,
    justifyContent: 'center',
    width: 54,
  },
  avatarText: { fontSize: 18, fontWeight: '800' },
  main: { flex: 1, minWidth: 0 },
  nameRow: { alignItems: 'center', flexDirection: 'row', gap: 7 },
  customer: { color: colors.text, flexShrink: 1, fontSize: 16, fontWeight: '800' },
  model: { color: colors.muted, fontSize: 12, fontWeight: '600', marginTop: 3 },
  phone: { color: '#059669', fontSize: 12, fontWeight: '700', marginTop: 5 },
  status: { borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3 },
  statusText: { fontSize: 10, fontWeight: '800' },
  chevron: { color: colors.primary, fontSize: 28, fontWeight: '400' },
  leadFooter: {
    alignItems: 'center',
    borderTopColor: colors.border,
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: 13,
    marginTop: 12,
    paddingTop: 10,
  },
  footerLabel: { color: colors.muted, fontSize: 9, fontWeight: '700' },
  footerValue: { color: colors.text, fontSize: 11, fontWeight: '800', marginTop: 3, maxWidth: 150 },
  footerDivider: { backgroundColor: colors.border, height: 27, width: 1 },
  empty: { color: colors.muted, fontSize: 12, padding: 28, textAlign: 'center' },
  pagination: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  pageButton: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 13,
    paddingVertical: 9,
  },
  disabled: { opacity: 0.45 },
  pageText: { color: colors.primary, fontSize: 12, fontWeight: '800' },
  pageLabel: { color: colors.muted, fontSize: 12, fontWeight: '700' },
});
