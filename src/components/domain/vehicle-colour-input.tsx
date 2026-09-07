'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { SearchSelect } from '@/components/ui/search-select';
import { Button } from '@/components/ui/button';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { fetchVehicleColourOptions } from '@/features/administration/master-data-workspace-api';

/** Preserve an existing colour snapshot even when its master was renamed/disabled. */
export function VehicleColourInput({
  name = 'color',
  defaultValue = '',
}: {
  name?: string;
  defaultValue?: string;
}) {
  const session = useWorkspaceSession();
  const [value, setValue] = useState(defaultValue);
  const [search, setSearch] = useState('');
  const term = useDebouncedValue(search, 300);
  const colours = useQuery({
    queryKey: ['vehicle-colour-options', ...workspaceQueryScope(session), term],
    queryFn: ({ signal }) => fetchVehicleColourOptions(term, signal),
  });
  const options = (colours.data ?? []).map((row) => ({ value: row.name, label: row.name }));
  if (value && !options.some((row) => row.value === value))
    options.unshift({ value, label: value });
  return (
    <div className="flex items-center gap-1">
      <input type="hidden" name={name} value={value} />
      <SearchSelect
        value={value}
        onValueChange={setValue}
        options={options}
        search={search}
        onSearchChange={setSearch}
        isPending={colours.isPending}
        isFetching={colours.isFetching}
        isError={colours.isError}
        aria-label="Vehicle colour"
        placeholder="Select colour"
        searchPlaceholder="Search colours…"
        emptyMessage="No saved colours. Ask your administrator to add colours in CRM Configuration."
      />
      {value && (
        <Button type="button" variant="ghost" size="sm" onClick={() => setValue('')}>
          Clear
        </Button>
      )}
    </div>
  );
}
