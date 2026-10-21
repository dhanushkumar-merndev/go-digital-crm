import { useCallback, useState } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { LeadRow, type LeadRowData } from '@/components/lead-row';
import { ListScreen } from '@/components/screen';
import { Chip } from '@/components/ui/basics';
import { dateRange, FilterBar, useFilters } from '@/components/ui/filter-sheet';
import { useWorkRefresh } from '@/features/call-flow/call-flow';
import { leadFilterGroups, orNull, safeSearch } from '@/lib/list-filters';
import { supabase } from '@/lib/supabase';
import { pageSize, usePagedList } from '@/lib/use-paged-list';
import { space } from '@/theme';

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
  };
}

function renderLead({ item }: { item: LeadRowData }) {
  return <LeadRow lead={item} />;
}

export function MobileLeadListScreen() {
  const [filter, setFilter] = useState<LeadFilter>('ALL');
  const [search, setSearch] = useState('');
  const filters = useFilters(leadFilterGroups);
  const { values } = filters;
  // The web lead workspace RPC resolves the caller's scope once. Reading
  // `leads` directly ran the RLS checks on every row in the organization and
  // hit the 8 s statement timeout at ~11k leads.
  const fetchPage = useCallback(
    async (page: number) => {
      const { data, error } = await supabase.rpc('get_lead_workspace_page_v2', {
        target_page: page,
        target_page_size: pageSize,
        target_search: safeSearch(search),
        target_status: filter.toLowerCase(),
        target_sort: 'updated:desc',
        target_stage: values.stage,
        target_source: orNull(values.source),
        target_model: orNull(values.model),
        target_followup_from: dateRange(values.followup).from,
        target_followup_to: dateRange(values.followup).to,
        target_created_from: dateRange(values.created).from,
        target_created_to: dateRange(values.created).to,
        target_buyer_type: values.buyer,
      });
      if (error || !data) throw error ?? new Error('LEADS_UNAVAILABLE');
      const result = data as { records?: Lead[] | null; total?: number | null };
      // Mapped once per page, so rows keep their identity and skip re-rendering.
      return {
        records: (result.records ?? []).map(toRow),
        total: Number(result.total ?? 0),
      };
    },
    [filter, search, values],
  );
  const list = usePagedList(fetchPage, { debounceMs: 300 });
  const narrowed = Boolean(search.trim()) || filters.active > 0;
  const { refresh } = list;
  useWorkRefresh(refresh);
  return (
    <ListScreen
      title="Leads"
      subtitle={
        list.total
          ? `${list.total.toLocaleString('en-IN')} ${narrowed ? 'matches' : 'in your queue'}`
          : undefined
      }
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
                selected={filter === item.value}
                onPress={() => setFilter(item.value)}
              />
            ))}
          </ScrollView>
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
    />
  );
}

const styles = StyleSheet.create({
  chips: { gap: space.sm },
});
