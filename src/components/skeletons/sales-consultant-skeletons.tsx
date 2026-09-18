'use client';

import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

// ==========================================
// 1. DASHBOARD SKELETON (SALES CONSULTANT)
// ==========================================
export function SalesConsultantDashboardSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-4">
      {/* Header */}
      <div className="flex flex-col justify-between gap-4 xl:flex-row xl:items-end">
        <div>
          <Skeleton className="h-8 w-64 md:h-9 md:w-80" />
          <Skeleton className="mt-1.5 h-4 w-72 md:w-96" />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Skeleton className="h-8 w-36 rounded-md" />
          <Skeleton className="h-4 w-28" />
        </div>
      </div>

      {/* 8 KPI Metrics */}
      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-8">
        {Array.from({ length: 8 }).map((_, i) => (
          <Card key={i} className="h-full min-w-0 border-slate-200/90 shadow-none">
            <CardContent className="p-4">
              <div className="flex items-center gap-2.5">
                <Skeleton className="size-8 shrink-0 rounded-lg" />
                <div className="min-w-0 flex-1 space-y-1">
                  <Skeleton className="h-3 w-full" />
                  <Skeleton className="h-3 w-2/3" />
                </div>
              </div>
              <div className="mt-3 flex justify-center">
                <Skeleton className="h-7 w-16" />
              </div>
              <div className="mt-3 flex items-center justify-center">
                <Skeleton className="h-3 w-24" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Main Grid: Left 8 cols, Right 4 cols */}
      <div className="grid gap-4 xl:grid-cols-12">
        {/* Left Column */}
        <div className="space-y-4 xl:col-span-8">
          {/* Requires attention card with 5 items */}
          <Card className="shadow-none">
            <CardHeader className="border-b px-4 py-3.5">
              <Skeleton className="h-4 w-36" />
            </CardHeader>
            <CardContent className="grid gap-2.5 p-3 sm:grid-cols-2 lg:grid-cols-5">
              {Array.from({ length: 5 }).map((_, i) => (
                <div
                  key={i}
                  className="flex min-h-32 flex-col rounded-lg border bg-slate-50/50 p-3"
                >
                  <div className="flex items-center gap-3">
                    <Skeleton className="size-8 rounded-lg" />
                    <Skeleton className="h-6 w-8" />
                  </div>
                  <div className="mt-3 space-y-1">
                    <Skeleton className="h-3 w-full" />
                    <Skeleton className="h-3 w-3/4" />
                  </div>
                  <div className="mt-auto flex items-center gap-1 pt-3">
                    <Skeleton className="h-3 w-16" />
                    <Skeleton className="size-3" />
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          {/* 12-col subgrid: Funnel (7) + Top Models & Quick Actions (5) */}
          <div className="grid gap-4 lg:grid-cols-12">
            <Card className="flex h-full flex-col overflow-hidden shadow-none lg:col-span-7">
              <CardHeader className="border-b px-4 py-3">
                <Skeleton className="h-4 w-40" />
              </CardHeader>
              <CardContent className="flex flex-1 flex-col p-3">
                <div className="flex h-[235px] gap-3">
                  {/* Funnel chart area */}
                  <div className="flex min-w-0 flex-1 flex-col justify-center space-y-2 px-4 py-2">
                    <Skeleton className="mx-auto h-7 w-full rounded" />
                    <Skeleton className="mx-auto h-7 w-[82%] rounded" />
                    <Skeleton className="mx-auto h-7 w-[64%] rounded" />
                    <Skeleton className="mx-auto h-7 w-[46%] rounded" />
                    <Skeleton className="mx-auto h-7 w-[28%] rounded" />
                  </div>
                  {/* Stages breakdown table */}
                  <div className="grid h-[235px] w-44 shrink-0 grid-rows-[25px_repeat(5,minmax(0,1fr))] border-l pl-3">
                    <div className="flex items-center justify-between border-b pb-1">
                      <Skeleton className="h-3 w-10" />
                      <Skeleton className="h-3 w-8" />
                    </div>
                    {Array.from({ length: 5 }).map((_, i) => (
                      <div
                        key={i}
                        className="flex items-center justify-between gap-2 border-b border-slate-100 py-1 last:border-0"
                      >
                        <div className="min-w-0 flex-1 space-y-1">
                          <Skeleton className="h-3 w-16" />
                          <Skeleton className="h-2 w-12" />
                        </div>
                        <Skeleton className="h-4 w-6 rounded" />
                      </div>
                    ))}
                  </div>
                </div>
                <div className="mt-auto flex items-center justify-between rounded-lg bg-slate-50 px-4 py-2.5">
                  <Skeleton className="h-3 w-32" />
                  <Skeleton className="h-4 w-12" />
                  <Skeleton className="h-3 w-10" />
                </div>
              </CardContent>
            </Card>

            <div className="space-y-4 lg:col-span-5">
              {/* Top performing models */}
              <Card className="shadow-none">
                <CardHeader className="flex-row items-center justify-between space-y-0 border-b px-4 py-3">
                  <Skeleton className="h-4 w-36" />
                  <Skeleton className="h-5 w-16 rounded-md" />
                </CardHeader>
                <CardContent className="space-y-1 p-3">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <div
                      key={i}
                      className="grid grid-cols-[52px_1fr_auto_auto] items-center gap-2 rounded-lg px-1.5 py-1.5"
                    >
                      <Skeleton className="h-8 w-12 rounded-md" />
                      <div className="min-w-0 space-y-1">
                        <Skeleton className="h-3 w-20" />
                        <Skeleton className="h-2.5 w-14" />
                      </div>
                      <Skeleton className="h-3 w-4" />
                      <Skeleton className="h-3 w-8" />
                    </div>
                  ))}
                </CardContent>
              </Card>

              {/* Quick Actions */}
              <Card className="shadow-none">
                <CardHeader className="border-b px-4 py-3">
                  <Skeleton className="h-4 w-24" />
                </CardHeader>
                <CardContent className="grid grid-cols-5 gap-1.5 p-3">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <div key={i} className="flex flex-col items-center p-1.5 text-center">
                      <Skeleton className="size-8 rounded-lg" />
                      <Skeleton className="mt-1.5 h-2.5 w-12" />
                    </div>
                  ))}
                </CardContent>
              </Card>
            </div>
          </div>

          {/* Recent Leads Table */}
          <Card className="overflow-hidden shadow-none">
            <CardHeader className="flex-row items-center justify-between space-y-0 border-b px-4 py-3">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-20" />
            </CardHeader>
            <CardContent className="p-0">
              <div className="border-b bg-slate-50/80 px-3 py-2.5">
                <div className="flex items-center justify-between">
                  <Skeleton className="h-3 w-16" />
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="hidden h-3 w-20 lg:block" />
                  <Skeleton className="hidden h-3 w-24 lg:block" />
                  <Skeleton className="hidden h-3 w-24 lg:block" />
                  <Skeleton className="h-3 w-14" />
                  <Skeleton className="h-3 w-14" />
                  <Skeleton className="h-3 w-10" />
                </div>
              </div>
              <div className="divide-y">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="flex items-center justify-between px-3 py-2.5">
                    <Skeleton className="h-3.5 w-16" />
                    <Skeleton className="h-3.5 w-24" />
                    <Skeleton className="hidden h-3.5 w-20 lg:block" />
                    <Skeleton className="hidden h-3.5 w-24 lg:block" />
                    <Skeleton className="hidden h-3.5 w-24 lg:block" />
                    <Skeleton className="h-5 w-16 rounded" />
                    <Skeleton className="h-5 w-14 rounded" />
                    <Skeleton className="h-6 w-6 rounded-md" />
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Right Column */}
        <div className="space-y-4 xl:col-span-4">
          {/* Today's Schedule Card */}
          <Card className="flex h-[22rem] min-h-0 flex-col overflow-hidden shadow-none xl:h-[690px]">
            <CardHeader className="flex-row items-center justify-between space-y-0 border-b px-4 py-3.5">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-20" />
            </CardHeader>
            <CardContent className="flex min-h-0 flex-1 flex-col p-3">
              <div className="relative space-y-2 pr-2 before:absolute before:bottom-5 before:left-[52px] before:top-5 before:w-px before:bg-slate-200">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="relative grid grid-cols-[48px_1fr] gap-3">
                    <Skeleton className="mt-3 h-3 w-10" />
                    <div className="ml-2 rounded-lg border bg-slate-50/50 p-2.5">
                      <div className="flex items-start gap-2.5">
                        <Skeleton className="size-7 shrink-0 rounded-md" />
                        <div className="min-w-0 flex-1 space-y-1.5">
                          <div className="flex items-center justify-between">
                            <Skeleton className="h-3 w-16" />
                            <Skeleton className="h-4 w-14 rounded" />
                          </div>
                          <Skeleton className="h-3.5 w-28" />
                          <Skeleton className="h-2.5 w-36" />
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Tasks & Alerts Card */}
          <Card className="overflow-hidden shadow-none">
            <CardHeader className="flex-row items-center justify-between space-y-0 border-b px-4 py-3">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-3 w-16" />
            </CardHeader>
            <CardContent className="divide-y p-0">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 px-4 py-3">
                  <Skeleton className="size-7 shrink-0 rounded-md" />
                  <Skeleton className="h-3.5 flex-1" />
                  <Skeleton className="h-4 w-6" />
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

// ==========================================
// 1.1 DASHBOARD SKELETON (TELECALLER)
// ==========================================
export function TelecallerDashboardSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-4">
      {/* Header */}
      <div className="flex flex-col justify-between gap-4 xl:flex-row xl:items-end">
        <div>
          <Skeleton className="h-8 w-60 md:h-9 md:w-72" />
          <Skeleton className="mt-1.5 h-4 w-72 md:w-96" />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Skeleton className="h-8 w-36 rounded-md" />
          <Skeleton className="h-4 w-28" />
        </div>
      </div>

      {/* 8 KPI Metrics */}
      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-8">
        {Array.from({ length: 8 }).map((_, i) => (
          <Card key={i} className="h-full min-w-0 border-slate-200/90 shadow-none">
            <CardContent className="p-4">
              <div className="flex items-center gap-2.5">
                <Skeleton className="size-8 shrink-0 rounded-lg" />
                <div className="min-w-0 flex-1 space-y-1">
                  <Skeleton className="h-3 w-full" />
                  <Skeleton className="h-3 w-2/3" />
                </div>
              </div>
              <div className="mt-3 flex justify-center">
                <Skeleton className="h-7 w-16" />
              </div>
              <div className="mt-3 flex items-center justify-center">
                <Skeleton className="h-3 w-24" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Main Grid: Left 8 cols, Right 4 cols */}
      <div className="grid gap-4 xl:grid-cols-12">
        {/* Left Column */}
        <div className="space-y-4 xl:col-span-8">
          {/* Requires attention card with 5 items */}
          <Card className="shadow-none">
            <CardHeader className="border-b px-4 py-3.5">
              <Skeleton className="h-4 w-36" />
            </CardHeader>
            <CardContent className="grid gap-2.5 p-3 sm:grid-cols-2 lg:grid-cols-5">
              {Array.from({ length: 5 }).map((_, i) => (
                <div
                  key={i}
                  className="flex min-h-32 flex-col rounded-lg border bg-slate-50/50 p-3"
                >
                  <div className="flex items-center gap-3">
                    <Skeleton className="size-8 rounded-lg" />
                    <Skeleton className="h-6 w-8" />
                  </div>
                  <div className="mt-3 space-y-1">
                    <Skeleton className="h-3 w-full" />
                    <Skeleton className="h-3 w-3/4" />
                  </div>
                  <div className="mt-auto flex items-center gap-1 pt-3">
                    <Skeleton className="h-3 w-16" />
                    <Skeleton className="size-3" />
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          {/* 12-col subgrid: Funnel (7) + Activity Trend & Quick Actions (5) */}
          <div className="grid gap-4 lg:grid-cols-12">
            <Card className="flex h-full flex-col overflow-hidden shadow-none lg:col-span-7">
              <CardHeader className="border-b px-4 py-3">
                <Skeleton className="h-4 w-40" />
              </CardHeader>
              <CardContent className="flex flex-1 flex-col p-3">
                <div className="flex h-[235px] gap-3">
                  {/* Funnel chart area */}
                  <div className="flex min-w-0 flex-1 flex-col justify-center space-y-2 px-4 py-2">
                    <Skeleton className="mx-auto h-7 w-full rounded" />
                    <Skeleton className="mx-auto h-7 w-[82%] rounded" />
                    <Skeleton className="mx-auto h-7 w-[64%] rounded" />
                    <Skeleton className="mx-auto h-7 w-[46%] rounded" />
                    <Skeleton className="mx-auto h-7 w-[28%] rounded" />
                  </div>
                  {/* Stages breakdown table */}
                  <div className="grid h-[235px] w-44 shrink-0 grid-rows-[25px_repeat(5,minmax(0,1fr))] border-l pl-3">
                    <div className="flex items-center justify-between border-b pb-1">
                      <Skeleton className="h-3 w-10" />
                      <Skeleton className="h-3 w-8" />
                    </div>
                    {Array.from({ length: 5 }).map((_, i) => (
                      <div
                        key={i}
                        className="flex items-center justify-between gap-2 border-b border-slate-100 py-1 last:border-0"
                      >
                        <div className="min-w-0 flex-1 space-y-1">
                          <Skeleton className="h-3 w-16" />
                          <Skeleton className="h-2 w-12" />
                        </div>
                        <Skeleton className="h-4 w-6 rounded" />
                      </div>
                    ))}
                  </div>
                </div>
                <div className="mt-auto flex items-center justify-between rounded-lg bg-slate-50 px-4 py-2.5">
                  <Skeleton className="h-3 w-40" />
                  <Skeleton className="h-4 w-12" />
                  <Skeleton className="h-3 w-10" />
                </div>
              </CardContent>
            </Card>

            <div className="space-y-4 lg:col-span-5">
              {/* Activity Trend Line Chart */}
              <Card className="shadow-none">
                <CardHeader className="flex-row items-center justify-between space-y-0 border-b px-4 py-3">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-5 w-20 rounded-md" />
                </CardHeader>
                <CardContent className="p-3">
                  <Skeleton className="h-[168px] w-full rounded-md" />
                </CardContent>
              </Card>

              {/* Quick Actions */}
              <Card className="shadow-none">
                <CardHeader className="border-b px-4 py-3">
                  <Skeleton className="h-4 w-24" />
                </CardHeader>
                <CardContent className="grid grid-cols-5 gap-1.5 p-3">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <div key={i} className="flex flex-col items-center p-1.5 text-center">
                      <Skeleton className="size-8 rounded-lg" />
                      <Skeleton className="mt-1.5 h-2.5 w-12" />
                    </div>
                  ))}
                </CardContent>
              </Card>
            </div>
          </div>

          {/* Recent Leads Table */}
          <Card className="overflow-hidden shadow-none">
            <CardHeader className="flex-row items-center justify-between space-y-0 border-b px-4 py-3">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-20" />
            </CardHeader>
            <CardContent className="p-0">
              <div className="border-b bg-slate-50/80 px-3 py-2.5">
                <div className="flex items-center justify-between">
                  <Skeleton className="h-3 w-16" />
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="hidden h-3 w-20 lg:block" />
                  <Skeleton className="hidden h-3 w-24 lg:block" />
                  <Skeleton className="hidden h-3 w-24 lg:block" />
                  <Skeleton className="h-3 w-14" />
                  <Skeleton className="h-3 w-14" />
                  <Skeleton className="h-3 w-10" />
                </div>
              </div>
              <div className="divide-y">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="flex items-center justify-between px-3 py-2.5">
                    <Skeleton className="h-3.5 w-24" />
                    <Skeleton className="hidden h-3.5 w-20 lg:block" />
                    <Skeleton className="hidden h-3.5 w-16 lg:block" />
                    <Skeleton className="hidden h-3.5 w-24 lg:block" />
                    <Skeleton className="hidden h-3.5 w-24 lg:block" />
                    <Skeleton className="h-5 w-16 rounded" />
                    <Skeleton className="h-5 w-14 rounded" />
                    <Skeleton className="h-6 w-6 rounded-md" />
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Right Column */}
        <div className="space-y-4 xl:col-span-4">
          {/* Overdue Queue Card */}
          <Card className="flex h-[22rem] min-h-0 flex-col overflow-hidden shadow-none xl:h-[690px]">
            <CardHeader className="flex-row items-center justify-between space-y-0 border-b px-4 py-3.5">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-24" />
            </CardHeader>
            <CardContent className="flex min-h-0 flex-1 flex-col p-3">
              <div className="relative space-y-2 pr-2 before:absolute before:bottom-5 before:left-[52px] before:top-5 before:w-px before:bg-slate-200">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="relative grid grid-cols-[48px_1fr] gap-3">
                    <Skeleton className="mt-3 h-3 w-10" />
                    <div className="ml-2 rounded-lg border bg-slate-50/50 p-2.5">
                      <div className="flex items-start gap-2.5">
                        <Skeleton className="size-7 shrink-0 rounded-md" />
                        <div className="min-w-0 flex-1 space-y-1.5">
                          <div className="flex items-center justify-between">
                            <Skeleton className="h-3 w-16" />
                            <Skeleton className="h-4 w-14 rounded" />
                          </div>
                          <Skeleton className="h-3.5 w-28" />
                          <Skeleton className="h-2.5 w-36" />
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Tasks & Alerts Card */}
          <Card className="overflow-hidden shadow-none">
            <CardHeader className="flex-row items-center justify-between space-y-0 border-b px-4 py-3">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-3 w-16" />
            </CardHeader>
            <CardContent className="divide-y p-0">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 px-4 py-3">
                  <Skeleton className="size-7 shrink-0 rounded-md" />
                  <Skeleton className="h-3.5 flex-1" />
                  <Skeleton className="h-4 w-6" />
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

// ==========================================
// 2. MY LEADS SKELETON
// ==========================================
export function LeadWorkspaceSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      {/* Header */}
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="size-3 rounded-full" />
            <Skeleton className="h-3 w-20" />
          </div>
          <Skeleton className="h-8 w-44" />
          <Skeleton className="mt-1 h-4 w-96 max-w-full" />
        </div>
        <Skeleton className="h-9 w-24 rounded-md shrink-0" />
      </div>

      {/* 8 Status Tabs */}
      <div className="flex h-10 gap-3 border-b overflow-x-auto">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex items-center gap-1.5 px-3">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 w-6 rounded" />
          </div>
        ))}
      </div>

      {/* Table Shell with Filters */}
      <Card className="shadow-none">
        {/* Filter bar */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
          <div className="flex flex-wrap items-center gap-2.5 flex-1">
            <Skeleton className="h-9 w-60 rounded-md" />
            <Skeleton className="h-9 w-36 rounded-md" />
            <Skeleton className="h-9 w-32 rounded-md" />
            <Skeleton className="h-9 w-32 rounded-md" />
            <Skeleton className="h-9 w-28 rounded-md" />
          </div>
          <div className="flex items-center gap-2">
            <Skeleton className="h-9 w-36 rounded-md" />
            <Skeleton className="h-9 w-24 rounded-md" />
          </div>
        </div>

        {/* Table Rows */}
        <div className="p-0">
          <div className="border-b bg-muted/40 px-4 py-3 flex items-center justify-between">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-3 w-14" />
          </div>
          <div className="divide-y">
            {Array.from({ length: 7 }).map((_, i) => (
              <div key={i} className="flex items-center justify-between px-4 py-3.5">
                <Skeleton className="h-4 w-16" />
                <div className="flex items-center gap-2 w-32">
                  <Skeleton className="size-6 rounded-full" />
                  <Skeleton className="h-4 w-20" />
                </div>
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-5 w-20 rounded-full" />
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-5 w-20 rounded-full" />
                <Skeleton className="h-5 w-14 rounded-full" />
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-5 w-20 rounded-full" />
                <Skeleton className="size-8 rounded-md" />
              </div>
            ))}
          </div>
        </div>

        {/* Pagination Footer */}
        <div className="flex items-center justify-between border-t px-4 py-3">
          <Skeleton className="h-4 w-32" />
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-20 rounded-md" />
            <Skeleton className="h-8 w-8 rounded-md" />
            <Skeleton className="h-8 w-8 rounded-md" />
          </div>
        </div>
      </Card>
    </div>
  );
}

// ==========================================
// 3. FOLLOW-UPS SKELETON
// ==========================================
export function FollowupsSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      {/* Header */}
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="size-3 rounded-full" />
            <Skeleton className="h-3 w-20" />
          </div>
          <Skeleton className="h-8 w-40" />
          <Skeleton className="mt-1 h-4 w-96 max-w-full" />
        </div>
        <Skeleton className="h-9 w-36 rounded-md shrink-0" />
      </div>

      {/* 4 KPI Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="shadow-none">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="size-8 rounded-lg" />
              </div>
              <Skeleton className="mt-3 h-7 w-16" />
              <Skeleton className="mt-1.5 h-3 w-28" />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Table Card */}
      <Card className="shadow-none">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-24 rounded-md" />
            <Skeleton className="h-8 w-24 rounded-md" />
            <Skeleton className="h-8 w-24 rounded-md" />
          </div>
          <div className="flex items-center gap-2">
            <Skeleton className="h-9 w-52 rounded-md" />
            <Skeleton className="h-9 w-32 rounded-md" />
          </div>
        </div>

        <div className="divide-y">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center justify-between px-4 py-3.5">
              <div className="flex items-center gap-3">
                <Skeleton className="size-8 rounded-full" />
                <div>
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="mt-1 h-3 w-24" />
                </div>
              </div>
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-5 w-20 rounded-full" />
              <Skeleton className="h-5 w-16 rounded-full" />
              <Skeleton className="h-5 w-24 rounded-full" />
              <Skeleton className="h-8 w-8 rounded-md" />
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between border-t px-4 py-3">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-8 w-24 rounded-md" />
        </div>
      </Card>
    </div>
  );
}

// ==========================================
// 4. TASKS SKELETON
// ==========================================
export function TasksSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      {/* Header */}
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="size-3 rounded-full" />
            <Skeleton className="h-3 w-16" />
          </div>
          <Skeleton className="h-8 w-32" />
          <Skeleton className="mt-1 h-4 w-80 max-w-full" />
        </div>
        <Skeleton className="h-9 w-32 rounded-md shrink-0" />
      </div>

      {/* 4 KPI Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="shadow-none">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <Skeleton className="h-4 w-20" />
                <Skeleton className="size-8 rounded-lg" />
              </div>
              <Skeleton className="mt-3 h-7 w-14" />
              <Skeleton className="mt-1.5 h-3 w-24" />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Tabs & Table */}
      <Card className="shadow-none">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-16 rounded-md" />
            <Skeleton className="h-8 w-24 rounded-md" />
            <Skeleton className="h-8 w-20 rounded-md" />
            <Skeleton className="h-8 w-24 rounded-md" />
          </div>
          <div className="flex items-center gap-2">
            <Skeleton className="h-9 w-48 rounded-md" />
            <Skeleton className="h-9 w-28 rounded-md" />
          </div>
        </div>

        <div className="divide-y">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center justify-between px-4 py-3.5">
              <div className="flex items-center gap-3">
                <Skeleton className="size-5 rounded" />
                <div>
                  <Skeleton className="h-4 w-44" />
                  <Skeleton className="mt-1 h-3 w-64" />
                </div>
              </div>
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-5 w-16 rounded-full" />
              <Skeleton className="h-5 w-20 rounded-full" />
              <Skeleton className="size-8 rounded-md" />
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between border-t px-4 py-3">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-8 w-24 rounded-md" />
        </div>
      </Card>
    </div>
  );
}

// ==========================================
// 5. CALLS SKELETON (Matches screenshot exactly!)
// ==========================================
export function CallsSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      {/* Top Header */}
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="size-3 rounded-full" />
            <Skeleton className="h-3 w-16" />
          </div>
          <Skeleton className="h-8 w-32" />
          <Skeleton className="mt-1 h-4 w-[480px] max-w-full" />
        </div>
        <Skeleton className="h-9 w-32 rounded-md shrink-0" />
      </div>

      {/* 5 Tab Navigation (Today's calls, Call history, Missed calls, Recordings, AI summary) */}
      <div className="flex h-10 gap-4 border-b overflow-x-auto">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-5 w-24" />
      </div>

      {/* 5 KPI Metric Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Card key={i} className="shadow-none">
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <Skeleton className="size-9 rounded-full shrink-0" />
                <div>
                  <Skeleton className="h-3.5 w-20" />
                  <Skeleton className="mt-1.5 h-6 w-12" />
                </div>
              </div>
              <Skeleton className="mt-2.5 h-3 w-36" />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Main Filter & Calls Table Card */}
      <Card className="shadow-none">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b p-4">
          <div>
            <Skeleton className="h-5 w-24" />
            <Skeleton className="mt-1 h-3.5 w-60" />
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            <Skeleton className="h-9 w-56 rounded-md" />
            <Skeleton className="h-9 w-28 rounded-md" />
            <Skeleton className="h-9 w-28 rounded-md" />
            <Skeleton className="h-9 w-28 rounded-md" />
            <Skeleton className="h-9 w-32 rounded-md" />
            <Skeleton className="h-9 w-20 rounded-md" />
          </div>
        </div>

        {/* Table Headers */}
        <div className="border-b bg-muted/40 px-4 py-3 flex items-center justify-between text-xs font-semibold text-muted-foreground">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-14" />
        </div>

        {/* Table Rows */}
        <div className="divide-y">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center justify-between px-4 py-3.5">
              <div className="flex items-center gap-2.5 w-28">
                <Skeleton className="size-7 rounded-full" />
                <Skeleton className="h-4 w-16" />
              </div>
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-5 w-24 rounded-full" />
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-4 w-12" />
              <Skeleton className="h-5 w-16 rounded-full" />
              <Skeleton className="h-8 w-8 rounded-full" />
              <Skeleton className="h-5 w-16 rounded-full" />
              <Skeleton className="h-5 w-20 rounded-full" />
              <Skeleton className="h-8 w-8 rounded-md" />
            </div>
          ))}
        </div>

        {/* Table Footer */}
        <div className="flex items-center justify-between border-t px-4 py-3">
          <Skeleton className="h-4 w-32" />
          <div className="flex items-center gap-2">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-8 w-8 rounded-md" />
            <Skeleton className="h-8 w-8 rounded-md" />
          </div>
        </div>
      </Card>
    </div>
  );
}

// ==========================================
// 6. AI VOICE CALLS SKELETON
// ==========================================
export function AiVoiceCallsSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      {/* Header */}
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="size-3 rounded-full" />
            <Skeleton className="h-3 w-24" />
          </div>
          <Skeleton className="h-8 w-44" />
          <Skeleton className="mt-1 h-4 w-96 max-w-full" />
        </div>
      </div>

      {/* 4 KPI Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="shadow-none">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="size-8 rounded-lg" />
              </div>
              <Skeleton className="mt-3 h-7 w-16" />
              <Skeleton className="mt-1.5 h-3 w-28" />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Table Card */}
      <Card className="shadow-none">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
          <Skeleton className="h-9 w-64 rounded-md" />
          <div className="flex items-center gap-2">
            <Skeleton className="h-9 w-36 rounded-md" />
            <Skeleton className="h-9 w-24 rounded-md" />
          </div>
        </div>

        <div className="border-b bg-muted/40 px-4 py-3 flex items-center justify-between">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-3 w-36" />
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-14" />
        </div>

        <div className="divide-y">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center justify-between px-4 py-3.5">
              <Skeleton className="h-4 w-20" />
              <div className="w-28">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="mt-1 h-3 w-20" />
              </div>
              <Skeleton className="h-5 w-28 rounded-full" />
              <Skeleton className="h-4 w-44" />
              <Skeleton className="h-5 w-16 rounded-full" />
              <Skeleton className="h-4 w-12" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="size-8 rounded-md" />
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between border-t px-4 py-3">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-8 w-24 rounded-md" />
        </div>
      </Card>
    </div>
  );
}

// ==========================================
// 7. INBOX SKELETON (Split Two-Pane Messenger)
// ==========================================
export function InboxSkeleton({ embedded = false }: { embedded?: boolean } = {}) {
  return (
    <div
      className={`mx-auto max-w-[1800px] ${embedded ? 'space-y-4' : 'flex h-[calc(100dvh-106px)] flex-col gap-3'}`}
    >
      {/* Header */}
      <div className="shrink-0">
        <div className="mb-2 flex items-center gap-2">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="size-3 rounded-full" />
          <Skeleton className="h-3 w-16" />
        </div>
        <Skeleton className="h-8 w-40" />
        <Skeleton className="mt-1 h-4 w-80 max-w-full" />
      </div>

      {/* Two-Pane Messenger Layout */}
      <Card
        className={`overflow-hidden shadow-none ${embedded ? 'h-[680px]' : 'min-h-0 flex-1'}`}
      >
        <div className="grid h-full min-h-0 grid-cols-1 grid-rows-[minmax(0,1fr)] lg:grid-cols-12">
          {/* Left: Conversation List */}
          <div className="border-r lg:col-span-4 flex flex-col">
            <div className="border-b p-3 space-y-2">
              <Skeleton className="h-9 w-full rounded-md" />
              <Skeleton className="h-8 w-full rounded-md" />
            </div>
            <div className="divide-y flex-1 overflow-y-auto">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="p-3.5 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                      <Skeleton className="size-8 rounded-full" />
                      <div>
                        <Skeleton className="h-4 w-28" />
                        <Skeleton className="mt-1 h-3 w-20" />
                      </div>
                    </div>
                    <Skeleton className="h-3 w-12" />
                  </div>
                  <div className="flex items-center justify-between pl-10">
                    <Skeleton className="h-3 w-40" />
                    <Skeleton className="h-4 w-14 rounded-full" />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Right: Active Chat View */}
          <div className="lg:col-span-8 flex flex-col bg-slate-50/50">
            {/* Chat Header */}
            <div className="flex items-center justify-between border-b bg-white p-3.5">
              <div className="flex items-center gap-3">
                <Skeleton className="size-10 rounded-full" />
                <div>
                  <Skeleton className="h-4 w-36" />
                  <Skeleton className="mt-1 h-3 w-24" />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Skeleton className="h-6 w-20 rounded-full" />
                <Skeleton className="h-8 w-28 rounded-md" />
              </div>
            </div>

            {/* Chat Message Stream */}
            <div className="flex-1 p-5 space-y-4">
              {/* Incoming Bubble */}
              <div className="flex items-start gap-2.5 max-w-[70%]">
                <Skeleton className="size-7 rounded-full shrink-0" />
                <div className="rounded-2xl rounded-tl-sm bg-white p-3 shadow-xs border">
                  <Skeleton className="h-4 w-48" />
                  <Skeleton className="mt-1.5 h-3 w-32" />
                  <Skeleton className="mt-2 h-2.5 w-12 ml-auto" />
                </div>
              </div>

              {/* Outgoing Bubble */}
              <div className="flex items-start justify-end gap-2.5 max-w-[70%] ml-auto">
                <div className="rounded-2xl rounded-tr-sm bg-blue-100 p-3">
                  <Skeleton className="h-4 w-56 bg-blue-200" />
                  <Skeleton className="mt-1.5 h-3 w-40 bg-blue-200" />
                  <Skeleton className="mt-2 h-2.5 w-16 ml-auto bg-blue-200" />
                </div>
              </div>

              {/* Incoming Bubble 2 */}
              <div className="flex items-start gap-2.5 max-w-[65%]">
                <Skeleton className="size-7 rounded-full shrink-0" />
                <div className="rounded-2xl rounded-tl-sm bg-white p-3 shadow-xs border">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="mt-2 h-2.5 w-12 ml-auto" />
                </div>
              </div>
            </div>

            {/* Bottom Composer */}
            <div className="border-t bg-white p-3 flex items-end gap-2">
              <Skeleton className="h-12 flex-1 rounded-md" />
              <Skeleton className="h-10 w-20 rounded-md" />
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

// ==========================================
// 8. APPOINTMENTS SKELETON
// ==========================================
export function AppointmentsSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      {/* Header */}
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="size-3 rounded-full" />
            <Skeleton className="h-3 w-24" />
          </div>
          <Skeleton className="h-8 w-44" />
          <Skeleton className="mt-1 h-4 w-96 max-w-full" />
        </div>
        <Skeleton className="h-9 w-40 rounded-md shrink-0" />
      </div>

      {/* 4 KPI Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="shadow-none">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="size-8 rounded-lg" />
              </div>
              <Skeleton className="mt-3 h-7 w-16" />
              <Skeleton className="mt-1.5 h-3 w-24" />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Filter and Table Card */}
      <Card className="shadow-none">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-20 rounded-md" />
            <Skeleton className="h-8 w-24 rounded-md" />
            <Skeleton className="h-8 w-20 rounded-md" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Skeleton className="h-9 w-48 rounded-md" />
            <Skeleton className="h-9 w-32 rounded-md" />
            <Skeleton className="h-9 w-28 rounded-md" />
          </div>
        </div>

        <div className="divide-y">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center justify-between px-4 py-3.5">
              <div className="flex items-center gap-3">
                <Skeleton className="size-8 rounded-full" />
                <div>
                  <Skeleton className="h-4 w-36" />
                  <Skeleton className="mt-1 h-3 w-28" />
                </div>
              </div>
              <Skeleton className="h-5 w-24 rounded-full" />
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-5 w-20 rounded-full" />
              <Skeleton className="size-8 rounded-md" />
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between border-t px-4 py-3">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-8 w-24 rounded-md" />
        </div>
      </Card>
    </div>
  );
}

// ==========================================
// 9. TEST DRIVES SKELETON
// ==========================================
export function TestDrivesSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      {/* Header */}
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="size-3 rounded-full" />
            <Skeleton className="h-3 w-20" />
          </div>
          <Skeleton className="h-8 w-40" />
          <Skeleton className="mt-1 h-4 w-96 max-w-full" />
        </div>
        <Skeleton className="h-9 w-36 rounded-md shrink-0" />
      </div>

      {/* 4 KPI Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="shadow-none">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="size-8 rounded-lg" />
              </div>
              <Skeleton className="mt-3 h-7 w-14" />
              <Skeleton className="mt-1.5 h-3 w-28" />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Table Card */}
      <Card className="shadow-none">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-20 rounded-md" />
            <Skeleton className="h-8 w-24 rounded-md" />
            <Skeleton className="h-8 w-24 rounded-md" />
          </div>
          <div className="flex items-center gap-2">
            <Skeleton className="h-9 w-52 rounded-md" />
            <Skeleton className="h-9 w-32 rounded-md" />
          </div>
        </div>

        <div className="divide-y">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center justify-between px-4 py-3.5">
              <Skeleton className="h-4 w-16" />
              <div className="w-32">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="mt-1 h-3 w-20" />
              </div>
              <Skeleton className="h-4 w-36" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-5 w-20 rounded-full" />
              <Skeleton className="h-5 w-16 rounded-full" />
              <Skeleton className="size-8 rounded-md" />
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between border-t px-4 py-3">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-8 w-24 rounded-md" />
        </div>
      </Card>
    </div>
  );
}

// ==========================================
// 10. COMPETITOR COMPARE SKELETON
// ==========================================
export function CompetitorCompareSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-5">
      {/* Header */}
      <div>
        <div className="mb-2 flex items-center gap-2">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="size-3 rounded-full" />
          <Skeleton className="h-3 w-28" />
        </div>
        <Skeleton className="h-8 w-56" />
        <Skeleton className="mt-1 h-4 w-[500px] max-w-full" />
      </div>

      {/* VS Selector Card */}
      <Card className="shadow-none">
        <CardContent className="grid gap-5 p-5 lg:grid-cols-[1fr_auto_1fr] items-center">
          <div className="space-y-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-10 w-full rounded-md" />
          </div>
          <div className="flex justify-center">
            <Skeleton className="size-9 rounded-full" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-10 w-full rounded-md" />
          </div>
        </CardContent>
      </Card>

      {/* Side-by-Side Model Comparison Cards */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="shadow-none border-blue-100">
          <CardHeader className="border-b px-5 py-4">
            <Skeleton className="h-5 w-36" />
            <Skeleton className="h-4 w-24 text-blue-600" />
          </CardHeader>
          <CardContent className="space-y-3 p-5">
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded border p-2.5">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="mt-1 h-5 w-24" />
              </div>
              <div className="rounded border p-2.5">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="mt-1 h-5 w-20" />
              </div>
            </div>
            <div className="space-y-2 pt-2">
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-5/6" />
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-none">
          <CardHeader className="border-b px-5 py-4">
            <Skeleton className="h-5 w-36" />
            <Skeleton className="h-4 w-24" />
          </CardHeader>
          <CardContent className="space-y-3 p-5">
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded border p-2.5">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="mt-1 h-5 w-24" />
              </div>
              <div className="rounded border p-2.5">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="mt-1 h-5 w-20" />
              </div>
            </div>
            <div className="space-y-2 pt-2">
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-5/6" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Detailed Spec Comparison Table */}
      <Card className="shadow-none">
        <CardHeader className="border-b px-5 py-4">
          <Skeleton className="h-4 w-44" />
        </CardHeader>
        <div className="divide-y">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="grid grid-cols-3 px-5 py-3 text-sm">
              <Skeleton className="h-4 w-32" />
              <div className="flex items-center gap-2">
                <Skeleton className="size-4 rounded-full" />
                <Skeleton className="h-4 w-28" />
              </div>
              <Skeleton className="h-4 w-28" />
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

// ==========================================
// 11. QUOTATIONS SKELETON
// ==========================================
export function QuotationsSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      {/* Header */}
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="size-3 rounded-full" />
            <Skeleton className="h-3 w-20" />
          </div>
          <Skeleton className="h-8 w-40" />
          <Skeleton className="mt-1 h-4 w-96 max-w-full" />
        </div>
        <Skeleton className="h-9 w-40 rounded-md shrink-0" />
      </div>

      {/* 4 KPI Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="shadow-none">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="size-8 rounded-lg" />
              </div>
              <Skeleton className="mt-3 h-7 w-16" />
              <Skeleton className="mt-1.5 h-3 w-28" />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Table Card */}
      <Card className="shadow-none">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
          <Skeleton className="h-9 w-60 rounded-md" />
          <div className="flex items-center gap-2">
            <Skeleton className="h-9 w-32 rounded-md" />
            <Skeleton className="h-9 w-28 rounded-md" />
          </div>
        </div>

        <div className="border-b bg-muted/40 px-4 py-3 flex items-center justify-between">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-3 w-36" />
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-14" />
        </div>

        <div className="divide-y">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center justify-between px-4 py-3.5">
              <Skeleton className="h-4 w-20" />
              <div className="w-32">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="mt-1 h-3 w-20" />
              </div>
              <Skeleton className="h-4 w-36" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-5 w-20 rounded-full" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-20" />
              <Skeleton className="size-8 rounded-md" />
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between border-t px-4 py-3">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-8 w-24 rounded-md" />
        </div>
      </Card>
    </div>
  );
}

// ==========================================
// 12. STOCK CHECK SKELETON
// ==========================================
export function StockCheckSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      {/* Header */}
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="size-3 rounded-full" />
            <Skeleton className="h-3 w-24" />
          </div>
          <Skeleton className="h-8 w-44" />
          <Skeleton className="mt-1 h-4 w-[460px] max-w-full" />
        </div>
      </div>

      {/* 4 Stock KPI Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="shadow-none">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="size-8 rounded-lg" />
              </div>
              <Skeleton className="mt-3 h-7 w-16" />
              <Skeleton className="mt-1.5 h-3 w-28" />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Stock Check Table Card with Multi-filter bar */}
      <Card className="shadow-none">
        <div className="border-b p-4">
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
            <Skeleton className="h-9 w-full rounded-md" />
            <Skeleton className="h-9 w-full rounded-md" />
            <Skeleton className="h-9 w-full rounded-md" />
            <Skeleton className="h-9 w-full rounded-md" />
            <Skeleton className="h-9 w-full rounded-md" />
            <Skeleton className="h-9 w-full rounded-md" />
          </div>
        </div>

        <div className="border-b bg-muted/40 px-4 py-3 flex items-center justify-between">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-3 w-14" />
        </div>

        <div className="divide-y">
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="flex items-center justify-between px-4 py-3.5">
              <div className="w-36">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="mt-1 h-3 w-20" />
              </div>
              <Skeleton className="h-5 w-20 rounded-full" />
              <div className="flex items-center gap-2">
                <Skeleton className="size-4 rounded-full" />
                <Skeleton className="h-4 w-16" />
              </div>
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-5 w-20 rounded-full" />
              <Skeleton className="h-4 w-16" />
              <Skeleton className="size-8 rounded-md" />
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between border-t px-4 py-3">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-8 w-24 rounded-md" />
        </div>
      </Card>
    </div>
  );
}

// ==========================================
// 13. EXCHANGE SKELETON
// ==========================================
export function SalesExchangeSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      {/* Header */}
      <div>
        <div className="mb-2 flex items-center gap-2">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="size-3 rounded-full" />
          <Skeleton className="h-3 w-20" />
        </div>
        <Skeleton className="h-8 w-56" />
        <Skeleton className="mt-1 h-4 w-96 max-w-full" />
      </div>

      {/* Case Lookup Selector */}
      <Card className="shadow-none">
        <CardContent className="p-4">
          <div className="flex flex-wrap items-center gap-3">
            <Skeleton className="h-10 flex-1 min-w-[240px] rounded-md" />
            <Skeleton className="h-10 w-36 rounded-md" />
          </div>
        </CardContent>
      </Card>

      {/* Workflow Stepper */}
      <Card className="shadow-none">
        <CardContent className="p-4">
          <div className="grid grid-cols-4 gap-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-2 rounded-lg border p-3">
                <Skeleton className="size-7 rounded-full" />
                <div>
                  <Skeleton className="h-3.5 w-20" />
                  <Skeleton className="mt-1 h-3 w-14" />
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Two Column Layout */}
      <div className="grid gap-6 lg:grid-cols-12">
        {/* Left Form (7 cols) */}
        <div className="space-y-6 lg:col-span-7">
          <Card className="shadow-none">
            <CardHeader className="border-b px-5 py-4">
              <Skeleton className="h-5 w-40" />
            </CardHeader>
            <CardContent className="space-y-4 p-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-9 w-full rounded-md" />
                </div>
                <div className="space-y-2">
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="h-9 w-full rounded-md" />
                </div>
                <div className="space-y-2">
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="h-9 w-full rounded-md" />
                </div>
                <div className="space-y-2">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-9 w-full rounded-md" />
                </div>
                <div className="space-y-2">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-9 w-full rounded-md" />
                </div>
                <div className="space-y-2">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-9 w-full rounded-md" />
                </div>
              </div>
              <div className="space-y-2 pt-2">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-20 w-full rounded-md" />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Right Evaluation & Docs (5 cols) */}
        <div className="space-y-6 lg:col-span-5">
          <Card className="shadow-none">
            <CardHeader className="border-b px-5 py-4">
              <Skeleton className="h-5 w-36" />
            </CardHeader>
            <CardContent className="space-y-4 p-5">
              <div className="rounded-lg border p-4 text-center">
                <Skeleton className="h-3.5 w-28 mx-auto" />
                <Skeleton className="mt-2 h-7 w-36 mx-auto" />
              </div>
              <div className="space-y-3 pt-2">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="flex items-center justify-between rounded border p-3">
                    <div className="flex items-center gap-2">
                      <Skeleton className="size-5 rounded" />
                      <Skeleton className="h-3.5 w-28" />
                    </div>
                    <Skeleton className="h-7 w-20 rounded" />
                  </div>
                ))}
              </div>
              <div className="flex gap-2 pt-4">
                <Skeleton className="h-10 flex-1 rounded-md" />
                <Skeleton className="h-10 flex-1 rounded-md" />
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

// ==========================================
// 14. BOOKINGS SKELETON
// ==========================================
export function BookingsSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      {/* Header */}
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="size-3 rounded-full" />
            <Skeleton className="h-3 w-20" />
          </div>
          <Skeleton className="h-8 w-36" />
          <Skeleton className="mt-1 h-4 w-96 max-w-full" />
        </div>
        <Skeleton className="h-9 w-36 rounded-md shrink-0" />
      </div>

      {/* 4 KPI Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="shadow-none">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="size-8 rounded-lg" />
              </div>
              <Skeleton className="mt-3 h-7 w-16" />
              <Skeleton className="mt-1.5 h-3 w-24" />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Table Card */}
      <Card className="shadow-none">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
          <Skeleton className="h-9 w-60 rounded-md" />
          <div className="flex flex-wrap items-center gap-2">
            <Skeleton className="h-9 w-32 rounded-md" />
            <Skeleton className="h-9 w-32 rounded-md" />
            <Skeleton className="h-9 w-28 rounded-md" />
          </div>
        </div>

        <div className="border-b bg-muted/40 px-4 py-3 flex items-center justify-between">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-3 w-36" />
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-14" />
        </div>

        <div className="divide-y">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center justify-between px-4 py-3.5">
              <Skeleton className="h-4 w-20" />
              <div className="w-32">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="mt-1 h-3 w-20" />
              </div>
              <Skeleton className="h-4 w-36" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-5 w-24 rounded-full" />
              <Skeleton className="h-5 w-20 rounded-full" />
              <Skeleton className="size-8 rounded-md" />
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between border-t px-4 py-3">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-8 w-24 rounded-md" />
        </div>
      </Card>
    </div>
  );
}

// ==========================================
// 15. PERFORMANCE SKELETON
// ==========================================
export function SalesConsultantPerformanceSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      {/* Header */}
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="size-3 rounded-full" />
            <Skeleton className="h-3 w-24" />
          </div>
          <Skeleton className="h-8 w-56" />
          <Skeleton className="mt-1 h-4 w-96 max-w-full" />
        </div>
        <Skeleton className="h-9 w-36 rounded-md shrink-0" />
      </div>

      {/* 8 KPI Cards Grid */}
      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-8">
        {Array.from({ length: 8 }).map((_, i) => (
          <Card key={i} className="shadow-none">
            <CardContent className="p-3.5">
              <div className="flex items-center justify-between">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="size-7 rounded-md" />
              </div>
              <Skeleton className="mt-2.5 h-6 w-14" />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* 3 Charts Grid */}
      <div className="grid gap-4 lg:grid-cols-12">
        <Card className="shadow-none lg:col-span-5">
          <CardHeader className="border-b px-4 py-3">
            <Skeleton className="h-4 w-36" />
          </CardHeader>
          <CardContent className="p-4">
            <div className="flex h-56 items-end justify-between gap-3 px-4 pt-6">
              {Array.from({ length: 7 }).map((_, i) => (
                <div key={i} className="flex-1 flex flex-col items-center gap-2">
                  <Skeleton
                    className="w-full rounded-t"
                    style={{ height: `${30 + ((i * 11) % 55)}%` }}
                  />
                  <Skeleton className="h-2.5 w-6" />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-none lg:col-span-4">
          <CardHeader className="border-b px-4 py-3">
            <Skeleton className="h-4 w-40" />
          </CardHeader>
          <CardContent className="p-4 space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="space-y-1">
                <div className="flex justify-between text-xs">
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="h-3 w-10" />
                </div>
                <Skeleton className="h-5 w-full rounded" style={{ width: `${100 - i * 15}%` }} />
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="shadow-none lg:col-span-3">
          <CardHeader className="border-b px-4 py-3">
            <Skeleton className="h-4 w-32" />
          </CardHeader>
          <CardContent className="flex flex-col items-center justify-center p-4">
            <Skeleton className="size-36 rounded-full" />
            <div className="mt-4 grid w-full grid-cols-2 gap-2">
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-full" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Target Achievement Breakdown Table */}
      <Card className="shadow-none">
        <CardHeader className="border-b px-5 py-4">
          <Skeleton className="h-4 w-48" />
        </CardHeader>
        <div className="divide-y">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-center justify-between px-5 py-4">
              <div className="w-44">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="mt-1 h-3 w-20" />
              </div>
              <div className="flex-1 max-w-md px-4">
                <Skeleton className="h-3 w-full rounded-full" />
              </div>
              <Skeleton className="h-5 w-24" />
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

// ==========================================
// 16. ACTIVITY TIMELINE SKELETON
// ==========================================
export function SalesConsultantTimelineSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      {/* Header */}
      <div>
        <div className="mb-2 flex items-center gap-2">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="size-3 rounded-full" />
          <Skeleton className="h-3 w-28" />
        </div>
        <Skeleton className="h-8 w-48" />
        <Skeleton className="mt-1 h-4 w-96 max-w-full" />
      </div>

      {/* Filter Tabs */}
      <div className="flex h-10 gap-2 border-b overflow-x-auto">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-7 w-20 rounded-md" />
        ))}
      </div>

      {/* Timeline Stream Card */}
      <Card className="shadow-none">
        <div className="border-b p-4 flex gap-3">
          <Skeleton className="h-9 w-60 rounded-md" />
          <Skeleton className="h-9 w-36 rounded-md" />
        </div>
        <CardContent className="p-6 space-y-6">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-start gap-4">
              <Skeleton className="size-9 rounded-full shrink-0" />
              <div className="flex-1 rounded-lg border p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <Skeleton className="h-4 w-44" />
                  <Skeleton className="h-3 w-24" />
                </div>
                <Skeleton className="h-3.5 w-3/4" />
                <div className="flex items-center gap-2 pt-2">
                  <Skeleton className="h-6 w-20 rounded-full" />
                  <Skeleton className="h-6 w-24 rounded-full" />
                </div>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

// ==========================================
// ROUTE-AWARE DISPATCHER FOR SALES CONSULTANT
// ==========================================
export function getSalesConsultantSkeleton(slug: string = 'dashboard') {
  switch (slug) {
    case 'dashboard':
      return <SalesConsultantDashboardSkeleton />;
    case 'my-leads':
    case 'team-leads':
    case 'showroom-leads':
    case 'sales-leads':
      return <LeadWorkspaceSkeleton />;
    case 'follow-ups':
      return <FollowupsSkeleton />;
    case 'tasks':
      return <TasksSkeleton />;
    case 'calls':
      return <CallsSkeleton />;
    case 'ai-voice-calls':
      return <AiVoiceCallsSkeleton />;
    case 'messages':
    case 'inbox':
      return <InboxSkeleton />;
    case 'appointments':
      return <AppointmentsSkeleton />;
    case 'test-drives':
      return <TestDrivesSkeleton />;
    case 'competitor-compare':
      return <CompetitorCompareSkeleton />;
    case 'quotations':
      return <QuotationsSkeleton />;
    case 'stock-check':
      return <StockCheckSkeleton />;
    case 'exchange':
      return <SalesExchangeSkeleton />;
    case 'bookings':
    case 'bookings-overview':
      return <BookingsSkeleton />;
    case 'performance':
      return <SalesConsultantPerformanceSkeleton />;
    case 'activity-timeline':
      return <SalesConsultantTimelineSkeleton />;
    default:
      return <CallsSkeleton />;
  }
}
