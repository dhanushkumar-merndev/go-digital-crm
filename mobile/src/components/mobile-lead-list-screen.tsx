import { router } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { LeadCard, timeAgo, type LeadRowData } from '@/components/lead-row';
import { ListScreen } from '@/components/screen';
import { Chip } from '@/components/ui/basics';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import { dateRange, FilterBar, useFilters } from '@/components/ui/filter-sheet';
import { useWorkRefresh } from '@/features/call-flow/call-flow';
import { leadFilterGroups, orNull, safeSearch } from '@/lib/list-filters';
import { supabase } from '@/lib/supabase';
import { pageSize, usePagedList } from '@/lib/use-paged-list';
import { colors, font, space } from '@/theme';

type Lead = {
  id: string;
  customer_name: string;
  phone: string;
  source: string;
  interested_model: string | null;
  lifecycle_status: string;
  temperature: 'COLD' | 'WARM' | 'HOT' | 'DORMANT' | null;
  next_followup_at: string | null;
  updated_at: string | null;
  /** Returned once the list RPC carries lead_requirements and the customer city. */
  budget_min?: number | null;
  budget_max?: number | null;
  customer_city?: string | null;
};

function lakhs(value: number) {
  const lakh = value / 100_000;
  return `${Number.isInteger(lakh) ? lakh : lakh.toFixed(1)}L`;
}

function budgetLabel(min?: number | null, max?: number | null) {
  if (min && max) return min === max ? `₹${lakhs(min)}` : `₹${lakhs(min)} – ${lakhs(max)}`;
  if (max) return `Up to ₹${lakhs(max)}`;
  if (min) return `From ₹${lakhs(min)}`;
  return null;
}

type LeadFilter = 'ALL' | 'HOT' | 'WARM' | 'COLD' | 'NEW';

const chipFilters: Array<{ value: LeadFilter; label: string }> = [
  { value: 'ALL', label: 'All' },
  { value: 'HOT', label: 'Hot' },
  { value: 'WARM', label: 'Warm' },
  { value: 'COLD', label: 'Cold' },
  { value: 'NEW', label: 'New' },
];

function toRow(lead: Lead): LeadRowData {
  return {
    id: lead.id,
    name: lead.customer_name,
    phone: lead.phone,
    model: lead.interested_model,
    source: lead.source,
    stage: lead.lifecycle_status,
    temperature: lead.temperature,
    nextFollowupAt: lead.next_followup_at,
    updatedAt: lead.updated_at,
    budget: budgetLabel(lead.budget_min, lead.budget_max),
    location: lead.customer_city ?? null,
  };
}

function renderLead({ item }: { item: LeadRowData }) {
  return <LeadCard lead={item} />;
}

const sortOptions: Array<{ value: string; label: string }> = [
  { value: 'updated:desc', label: 'Last updated' },
  { value: 'followup:asc', label: 'Next follow-up' },
  { value: 'created:desc', label: 'Newest enquiry' },
  { value: 'customer:asc', label: 'Name A–Z' },
];

type LeadKpis = { total: number; hot: number; warm: number; cold: number; new_count: number };

// Chip counts are leads, the same numbers the web tabs show; the list total
// below them counts mobile groups, so the two are read from different fields.
function chipCounts(kpis: LeadKpis | null | undefined): Record<LeadFilter, number> | undefined {
  if (!kpis) return undefined;
  return {
    ALL: Number(kpis.total ?? 0),
    HOT: Number(kpis.hot ?? 0),
    WARM: Number(kpis.warm ?? 0),
    COLD: Number(kpis.cold ?? 0),
    NEW: Number(kpis.new_count ?? 0),
  };
}

export function MobileLeadListScreen() {
  const [filter, setFilter] = useState<LeadFilter>('ALL');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState(sortOptions[0]!.value);
  const [sortOpen, setSortOpen] = useState(false);
  const [loadedAt, setLoadedAt] = useState<number>();
  const filters = useFilters(leadFilterGroups);
  const { values } = filters;
  // Only the first page asks for the counts; a later page reuses its total.
  const totalRef = useRef(0);
  // The web lead workspace RPC resolves the caller's scope once. Reading
  // `leads` directly ran the RLS checks on every row in the organization and
  // hit the 8 s statement timeout at ~11k leads.
  const fetchPage = useCallback(
    async (page: number) => {
      const firstPage = page === 1;
      const { data, error } = await supabase.rpc('get_lead_workspace_page_v2', {
        target_page: page,
        target_page_size: pageSize,
        target_search: safeSearch(search),
        target_status: filter.toLowerCase(),
        target_sort: sort,
        target_stage: values.stage,
        target_source: orNull(values.source),
        target_model: orNull(values.model),
        target_followup_from: dateRange(values.followup).from,
        target_followup_to: dateRange(values.followup).to,
        target_created_from: dateRange(values.created).from,
        target_created_to: dateRange(values.created).to,
        target_buyer_type: values.buyer,
        target_include_kpis: firstPage,
      });
      if (error || !data) throw error ?? new Error('LEADS_UNAVAILABLE');
      const result = data as {
        records?: Lead[] | null;
        total?: number | null;
        kpis?: LeadKpis | null;
      };
      if (firstPage) {
        totalRef.current = Number(result.total ?? 0);
        setLoadedAt(Date.now());
      }
      // Mapped once per page, so rows keep their identity and skip re-rendering.
      return {
        records: (result.records ?? []).map(toRow),
        total: totalRef.current,
        counts: firstPage ? chipCounts(result.kpis) : undefined,
      };
    },
    [filter, search, sort, values],
  );
  const list = usePagedList(fetchPage, { debounceMs: 300 });
  const narrowed = Boolean(search.trim()) || filters.active > 0;
  const { refresh } = list;
  useWorkRefresh(refresh);
  const leadCount = list.counts?.ALL;
  const sortLabel = sortOptions.find((option) => option.value === sort)?.label ?? 'Last updated';
  return (
    <ListScreen
      title="My Leads"
      subtitle={
        narrowed
          ? `${list.total.toLocaleString('en-IN')} matches`
          : typeof leadCount === 'number'
            ? `Total ${leadCount.toLocaleString('en-IN')} leads`
            : undefined
      }
      cards
      toolbar={
        <>
          <FilterBar
            search={search}
            onSearch={setSearch}
            placeholder="Search name or phone"
            filters={filters}
          />
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chips}
          >
            {chipFilters.map((item) => (
              <Chip
                key={item.value}
                label={item.label}
                count={list.counts?.[item.value]}
                selected={filter === item.value}
                onPress={() => setFilter(item.value)}
              />
            ))}
          </ScrollView>
          <View style={styles.sortBar}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Sort by ${sortLabel}`}
              onPress={() => setSortOpen(true)}
              hitSlop={8}
              style={styles.sortButton}
            >
              <Text style={styles.sortText}>
                Sort by: <Text style={styles.sortValue}>{sortLabel}</Text>
              </Text>
              <Icon name="chevron-down" size={16} color={colors.text} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Refresh leads"
              onPress={refresh}
              hitSlop={8}
              style={styles.updated}
            >
              <Text style={styles.updatedText}>
                Updated: {loadedAt ? (timeAgo(new Date(loadedAt).toISOString()) ?? 'now') : '…'}
              </Text>
              <Icon name="refresh" size={16} color={colors.muted} />
            </Pressable>
          </View>
        </>
      }
      data={list.items}
      keyExtractor={(lead) => lead.id}
      renderItem={renderLead}
      loading={list.loading}
      refreshing={list.refreshing}
      loadingMore={list.loadingMore}
      error={list.error}
      errorTitle="Leads could not load"
      emptyTitle={narrowed ? 'No lead matches' : 'No leads here'}
      emptyDetail={
        narrowed ? 'Try a name, the last digits of the phone, or fewer filters.' : undefined
      }
      emptyIcon="people-outline"
      onRefresh={list.refresh}
      onEndReached={list.loadMore}
      onRetry={list.reload}
      floating={
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Add lead"
            onPress={() => router.push('/new-lead')}
            style={({ pressed }) => [styles.fab, pressed && styles.fabPressed]}
          >
            <Icon name="add" size={30} color={colors.onColor} />
          </Pressable>
          {sortOpen ? (
            <Sheet title="Sort leads" onClose={() => setSortOpen(false)}>
              {sortOptions.map((option) => (
                <Pressable
                  key={option.value}
                  accessibilityRole="button"
                  onPress={() => {
                    setSort(option.value);
                    setSortOpen(false);
                  }}
                  style={styles.sortOption}
                >
                  <Text style={styles.sortOptionText}>{option.label}</Text>
                  {option.value === sort ? (
                    <Icon name="checkmark" size={18} color={colors.primary} />
                  ) : null}
                </Pressable>
              ))}
            </Sheet>
          ) : null}
        </>
      }
    />
  );
}

const styles = StyleSheet.create({
  chips: { gap: space.sm },
  sortBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: space.xs,
  },
  sortButton: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  sortText: { color: colors.muted, fontSize: font.small },
  sortValue: { color: colors.text, fontWeight: '600' },
  updated: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  updatedText: { color: colors.muted, fontSize: font.label },
  sortOption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: space.md,
  },
  sortOptionText: { color: colors.text, fontSize: font.body },
  fab: {
    position: 'absolute',
    right: space.lg + 4,
    bottom: space.lg + 4,
    width: 60,
    height: 60,
    borderRadius: 30,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
    elevation: 6,
    shadowColor: colors.primary,
    shadowOpacity: 0.3,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
  },
  fabPressed: { opacity: 0.85 },
});
