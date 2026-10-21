'use client';

import { ErrorState } from '@/components/shared/page-states';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { AttentionList } from '@/components/shared/attention-list';
import { DataTableShell } from '@/components/shared/data-table-shell';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageHeader, PageShell } from '@/components/shared/page-header';
import { PageSkeleton } from '@/components/shared/page-skeleton';
import { EChart } from '@/components/charts/e-chart';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { fetchPageData } from '@/lib/demo-page-repository';
import type { PageQuery, PageSpec } from '@/lib/domain';

export function WorkspacePage({ spec, role }: { spec: PageSpec; role: string }) {
  const [query, setQuery] = useState<PageQuery>({
    page: 1,
    pageSize: 25,
    search: '',
    status: 'all',
    sort: 'updated:desc',
  });
  const debouncedSearch = useDebouncedValue(query.search, 300);
  const requestQuery = { ...query, search: debouncedSearch };
  const result = useQuery({
    queryKey: ['workspace', role, spec.category, spec.title, requestQuery],
    queryFn: ({ signal }) => fetchPageData(spec, requestQuery, signal),
    placeholderData: keepPreviousData,
  });
  const onQueryChange = useCallback(
    (next: Partial<PageQuery>) => setQuery((current) => ({ ...current, ...next })),
    [],
  );
  if (result.isPending) return <PageSkeleton />;
  if (result.isError)
    return (
      <PageShell>
        <PageHeader spec={{ ...spec, primaryAction: undefined }} />
        <ErrorState
          title="We could not load this workspace"
          description="The request failed safely."
          reference="GDM-UI-QUERY"
          onRetry={() => void result.refetch()}
        />
      </PageShell>
    );
  return (
    <div className="mx-auto w-full">
      <PageHeader spec={spec} />
      <div className="space-y-6">
        <KpiGrid metrics={spec.metrics} />
        {(spec.attention || spec.chart) && (
          <div
            className={`grid gap-6 ${spec.attention && spec.chart ? 'xl:grid-cols-[0.8fr_1.2fr]' : ''}`}
          >
            {spec.attention && <AttentionList items={spec.attention} />}
            {spec.chart && (
              <Card className="shadow-none">
                <CardHeader className="pb-1">
                  <CardTitle className="text-base">{spec.chart.title}</CardTitle>
                  <CardDescription>{spec.chart.description}</CardDescription>
                </CardHeader>
                <CardContent>
                  <EChart kind={spec.chart.kind} data={result.data.chart} className="h-[280px]" />
                </CardContent>
              </Card>
            )}
          </div>
        )}
        <DataTableShell
          spec={spec}
          result={result.data}
          query={query}
          onQueryChange={onQueryChange}
          role={role}
          isFetching={result.isFetching}
        />
      </div>
    </div>
  );
}
