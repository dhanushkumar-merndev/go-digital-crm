'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { RotateCcw, TriangleAlert } from 'lucide-react';
import { useCallback, useState } from 'react';
import { AttentionList } from '@/components/shared/attention-list';
import { DataTableShell } from '@/components/shared/data-table-shell';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageHeader } from '@/components/shared/page-header';
import { PageSkeleton } from '@/components/shared/page-skeleton';
import { EChart } from '@/components/charts/e-chart';
import { Button } from '@/components/ui/button';
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
      <Card className="mx-auto max-w-xl">
        <CardContent className="flex flex-col items-center p-10 text-center">
          <div className="grid size-12 place-items-center rounded-full bg-red-50 text-red-600">
            <TriangleAlert />
          </div>
          <h2 className="mt-4 font-semibold">We could not load this workspace</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            The request failed safely. Reference: GDM-UI-QUERY
          </p>
          <Button className="mt-5" variant="outline" onClick={() => void result.refetch()}>
            <RotateCcw className="size-4" />
            Try again
          </Button>
        </CardContent>
      </Card>
    );
  return (
    <div className="mx-auto max-w-[1600px]">
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
