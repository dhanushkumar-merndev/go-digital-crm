'use client';

import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { SearchSelect, type SearchSelectOption } from '@/components/ui/search-select';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { retryRpcRead } from '@/lib/supabase/read-rpc';
import { fetchInterestedModelOptions } from './lead-workspace-api';

const CLEAR = '__CLEAR__';

/**
 * Searchable interested-model picker shared by Add lead and the lead's
 * Vehicle requirement editor. It lists the top catalogue/stock matches for the
 * branch and still accepts any typed name, because an enquiry can name a model
 * the dealership does not stock.
 */
export function InterestedModelPicker({
  value,
  onValueChange,
  branchId,
  enabled = true,
}: {
  value: string;
  onValueChange: (value: string) => void;
  branchId: string | null;
  enabled?: boolean;
}) {
  const queryScope = workspaceQueryScope(useWorkspaceSession());
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 250);
  const optionsQuery = useQuery({
    queryKey: ['lead-interested-models', ...queryScope, branchId ?? '', debouncedSearch],
    queryFn: ({ signal }) =>
      fetchInterestedModelOptions(
        { branchId: branchId || undefined, search: debouncedSearch, limit: 5 },
        signal,
      ),
    enabled,
    retry: retryRpcRead,
  });

  const options = useMemo<SearchSelectOption[]>(() => {
    const list: SearchSelectOption[] = (optionsQuery.data ?? []).map((item) => ({
      value: item.model_name,
      label: item.model_name,
      description: item.in_stock
        ? `In stock (${item.stock_count} unit${item.stock_count === 1 ? '' : 's'} at branch)`
        : item.brand_name
          ? `${item.brand_name} · Catalog`
          : 'Known model',
    }));
    const typed = search.trim();
    if (typed && !list.some((option) => option.value.toLowerCase() === typed.toLowerCase())) {
      list.push({ value: typed, label: `Use "${typed}"`, description: 'Custom model entry' });
    }
    if (value) {
      if (!list.some((option) => option.value.toLowerCase() === value.toLowerCase())) {
        list.unshift({ value, label: value, description: 'Selected model' });
      }
      list.push({
        value: CLEAR,
        label: 'Clear selection',
        description: 'Choose a different model',
      });
    }
    return list;
  }, [optionsQuery.data, search, value]);

  return (
    <SearchSelect
      value={value}
      search={search}
      onSearchChange={setSearch}
      onValueChange={(next) => {
        onValueChange(next === CLEAR ? '' : next);
        setSearch('');
      }}
      options={options}
      isPending={optionsQuery.isPending}
      isFetching={optionsQuery.isFetching}
      isError={optionsQuery.isError}
      placeholder="Select or search model"
      searchPlaceholder="Type model name (top 5)…"
      emptyMessage="No matching models. Type any name to enter a custom model."
      aria-label="Interested model"
    />
  );
}
