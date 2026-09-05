'use client';

import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

// ==========================================
// UNIVERSAL / ROLE-TAILORED TENANT DASHBOARD SKELETON
// ==========================================
export function TenantDashboardSkeleton({ role = 'general' }: { role?: string }) {
  const isCompact = ['finance', 'insurance', 'rto', 'exchange', 'delivery'].includes(role);
  const kpiCount = isCompact ? 4 : 8;

  return (
    <div className="mx-auto max-w-[1600px] space-y-5">
      {/* Dashboard Header */}
      <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <Skeleton className="mb-1 h-3.5 w-40" />
          <Skeleton className="h-8 w-60" />
          <Skeleton className="mt-1.5 h-4 w-[420px] max-w-full" />
        </div>
        <div className="flex items-center gap-3">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-9 w-24 rounded-md" />
        </div>
      </div>

      {/* KPI Cards Grid */}
      <div
        className={`grid gap-3 ${
          isCompact ? 'sm:grid-cols-2 xl:grid-cols-4' : 'sm:grid-cols-2 lg:grid-cols-8'
        }`}
      >
        {Array.from({ length: kpiCount }).map((_, i) => (
          <Card key={i} className="min-w-0 overflow-hidden shadow-none">
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-2">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="size-6 rounded-md" />
              </div>
              <Skeleton className="mt-2.5 h-7 w-14" />
              <Skeleton className="mt-1.5 h-2.5 w-24" />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* 12-col Grid: Priority Queue (5) + Activity Trend (7) */}
      <div className="grid gap-5 xl:grid-cols-12">
        {/* Priority Queues / Requires Attention */}
        <Card className="shadow-none xl:col-span-5">
          <CardHeader className="flex-row items-center justify-between space-y-0 border-b px-5 py-4">
            <div>
              <Skeleton className="h-4 w-36" />
              <Skeleton className="mt-1 h-3 w-48" />
            </div>
            <Skeleton className="h-4 w-20" />
          </CardHeader>
          <CardContent className="grid gap-3 p-4 sm:grid-cols-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="rounded-lg border p-4">
                <div className="flex items-center justify-between">
                  <Skeleton className="size-8 rounded-lg" />
                  <Skeleton className="h-6 w-10" />
                </div>
                <Skeleton className="mt-2 h-3.5 w-24" />
                <Skeleton className="mt-1 h-2.5 w-32" />
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Activity Trend Line Chart */}
        <Card className="shadow-none xl:col-span-7">
          <CardHeader className="flex-row items-start justify-between space-y-0 border-b px-5 py-4 pb-3">
            <div>
              <Skeleton className="h-4 w-32" />
              <Skeleton className="mt-1 h-3 w-44" />
            </div>
            <Skeleton className="h-3.5 w-24" />
          </CardHeader>
          <CardContent className="p-5">
            <Skeleton className="h-[275px] w-full rounded-md" />
          </CardContent>
        </Card>
      </div>

      {/* 12-col Grid: Lead / Case Preview Table (8) + Workload (4) */}
      <div className="grid gap-5 xl:grid-cols-12">
        {/* Left: Preview Table */}
        <div className="xl:col-span-8">
          <Card className="overflow-hidden shadow-none">
            <CardHeader className="flex flex-row items-center justify-between border-b px-5 py-4">
              <div>
                <Skeleton className="h-4 w-44" />
                <Skeleton className="mt-1 h-3 w-36" />
              </div>
              <Skeleton className="h-4 w-20" />
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y">
                <div className="flex items-center justify-between bg-slate-50/50 px-4 py-3">
                  <Skeleton className="h-3.5 w-32" />
                  <Skeleton className="h-3.5 w-24" />
                  <Skeleton className="h-3.5 w-20" />
                  <Skeleton className="h-3.5 w-20" />
                  <Skeleton className="h-3.5 w-16" />
                </div>
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="flex items-center justify-between px-4 py-3.5">
                    <div className="flex items-center gap-3">
                      <Skeleton className="size-8 rounded-full" />
                      <div>
                        <Skeleton className="h-4 w-32" />
                        <Skeleton className="mt-1 h-3 w-24" />
                      </div>
                    </div>
                    <Skeleton className="h-4 w-24" />
                    <Skeleton className="h-5 w-16 rounded-full" />
                    <Skeleton className="h-5 w-14 rounded-full" />
                    <Skeleton className="h-8 w-16 rounded-md" />
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Right: Today's Workload / Progress Bars */}
        <Card className="shadow-none xl:col-span-4">
          <CardHeader className="border-b px-5 py-4">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="mt-1 h-3 w-48" />
          </CardHeader>
          <CardContent className="space-y-4 p-5">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="space-y-1.5">
                <div className="flex justify-between">
                  <Skeleton className="h-3.5 w-28" />
                  <Skeleton className="h-3.5 w-10" />
                </div>
                <Skeleton className="h-2 w-full rounded-full" />
              </div>
            ))}
            <div className="border-t pt-4">
              <Skeleton className="h-9 w-full rounded-md" />
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
