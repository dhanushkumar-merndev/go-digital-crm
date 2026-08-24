'use client';

import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

// ==========================================
// 1. TEAM MANAGER PERFORMANCE SKELETON
// ==========================================
export function TeamManagerPerformanceSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Skeleton className="mb-2 h-3.5 w-44" />
          <Skeleton className="h-8 w-60" />
          <Skeleton className="mt-1.5 h-4 w-[420px] max-w-full" />
        </div>
        <Skeleton className="h-9 w-48 rounded-md" />
      </div>

      {/* 4 KPI Cards */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="shadow-none">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <Skeleton className="h-3.5 w-24" />
                <Skeleton className="size-8 rounded-lg" />
              </div>
              <Skeleton className="mt-3 h-7 w-20" />
              <Skeleton className="mt-2 h-3 w-36" />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Grid: Chart + Top Performers */}
      <div className="grid gap-4 xl:grid-cols-[1.05fr_1.35fr]">
        <Card className="shadow-none">
          <CardHeader className="border-b px-5 py-4">
            <Skeleton className="h-4 w-36" />
          </CardHeader>
          <CardContent className="p-5">
            <Skeleton className="h-[260px] w-full rounded-md" />
          </CardContent>
        </Card>

        <Card className="shadow-none">
          <CardHeader className="border-b px-5 py-4">
            <Skeleton className="h-4 w-32" />
          </CardHeader>
          <CardContent className="grid gap-3 p-5 md:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="rounded-lg border p-4">
                <div className="flex items-center justify-between">
                  <Skeleton className="size-8 rounded-full" />
                  <Skeleton className="h-5 w-14 rounded-full" />
                </div>
                <div className="mt-4 flex items-center gap-2">
                  <Skeleton className="size-9 rounded-full" />
                  <Skeleton className="h-4 w-28" />
                </div>
                <div className="mt-4 grid grid-cols-2 gap-2">
                  <Skeleton className="h-3 w-16" />
                  <Skeleton className="h-3 w-16" />
                  <Skeleton className="h-3 w-16" />
                  <Skeleton className="h-3 w-16" />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* Leaderboard Table */}
      <Card className="overflow-hidden shadow-none">
        <CardHeader className="border-b px-5 py-4">
          <Skeleton className="h-4 w-44" />
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y">
            <div className="flex items-center justify-between bg-slate-50/50 px-4 py-3">
              <Skeleton className="h-3.5 w-10" />
              <Skeleton className="h-3.5 w-32" />
              <Skeleton className="h-3.5 w-16" />
              <Skeleton className="h-3.5 w-16" />
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className="h-3.5 w-16" />
              <Skeleton className="h-3.5 w-20" />
            </div>
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center justify-between px-4 py-3.5">
                <Skeleton className="h-4 w-6" />
                <div className="flex items-center gap-2.5">
                  <Skeleton className="size-8 rounded-full" />
                  <Skeleton className="h-4 w-32" />
                </div>
                <Skeleton className="h-4 w-12" />
                <Skeleton className="h-4 w-12" />
                <Skeleton className="h-4 w-12" />
                <Skeleton className="h-4 w-12" />
                <Skeleton className="h-4 w-12" />
                <Skeleton className="h-4 w-12" />
                <Skeleton className="h-6 w-16 rounded-full" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ==========================================
// 2. TEAM CALL MONITOR SKELETON
// ==========================================
export function TeamCallMonitorSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Skeleton className="mb-2 h-3.5 w-40" />
          <Skeleton className="h-8 w-56" />
          <Skeleton className="mt-1.5 h-4 w-[380px] max-w-full" />
        </div>
        <Skeleton className="h-9 w-48 rounded-md" />
      </div>

      {/* 4 KPI Cards */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="shadow-none">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <Skeleton className="h-3.5 w-24" />
                <Skeleton className="size-8 rounded-lg" />
              </div>
              <Skeleton className="mt-3 h-7 w-20" />
              <Skeleton className="mt-2 h-3 w-32" />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Trend + Breakdown */}
      <div className="grid gap-4 xl:grid-cols-12">
        <Card className="shadow-none xl:col-span-7">
          <CardHeader className="border-b px-5 py-4">
            <Skeleton className="h-4 w-36" />
          </CardHeader>
          <CardContent className="p-5">
            <Skeleton className="h-[280px] w-full rounded-md" />
          </CardContent>
        </Card>

        <Card className="shadow-none xl:col-span-5">
          <CardHeader className="border-b px-5 py-4">
            <Skeleton className="h-4 w-40" />
          </CardHeader>
          <CardContent className="space-y-3 p-5">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center justify-between rounded-lg border p-3">
                <div className="flex items-center gap-3">
                  <Skeleton className="size-8 rounded-full" />
                  <div>
                    <Skeleton className="h-4 w-28" />
                    <Skeleton className="mt-1 h-3 w-20" />
                  </div>
                </div>
                <Skeleton className="h-6 w-16 rounded-full" />
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* Calls Log Table */}
      <Card className="overflow-hidden shadow-none">
        <CardHeader className="border-b px-5 py-4">
          <Skeleton className="h-4 w-48" />
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center justify-between px-4 py-3.5">
                <div className="flex items-center gap-3">
                  <Skeleton className="size-8 rounded-lg" />
                  <div>
                    <Skeleton className="h-4 w-36" />
                    <Skeleton className="mt-1 h-3 w-24" />
                  </div>
                </div>
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-6 w-20 rounded-full" />
                <Skeleton className="h-8 w-20 rounded-md" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ==========================================
// 3. SHOWROOM SALES TEAM SKELETON
// ==========================================
export function ShowroomSalesTeamSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Skeleton className="mb-2 h-3.5 w-44" />
          <Skeleton className="h-8 w-64" />
          <Skeleton className="mt-1.5 h-4 w-[400px] max-w-full" />
        </div>
        <div className="flex items-center gap-3">
          <Skeleton className="h-9 w-40 rounded-md" />
          <Skeleton className="h-9 w-28 rounded-md" />
        </div>
      </div>

      {/* 5 KPI Cards */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Card key={i} className="shadow-none">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <Skeleton className="h-3.5 w-24" />
                <Skeleton className="size-8 rounded-lg" />
              </div>
              <Skeleton className="mt-3 h-7 w-16" />
              <Skeleton className="mt-2 h-3 w-32" />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Team Table */}
      <Card className="overflow-hidden shadow-none">
        <CardHeader className="flex flex-row items-center justify-between border-b px-5 py-4">
          <Skeleton className="h-4 w-44" />
          <Skeleton className="h-8 w-32 rounded-md" />
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y">
            <div className="flex items-center justify-between bg-slate-50/50 px-4 py-3">
              <Skeleton className="h-3.5 w-28" />
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className="h-3.5 w-16" />
            </div>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center justify-between px-4 py-3.5">
                <div className="flex items-center gap-3">
                  <Skeleton className="size-8 rounded-full" />
                  <div>
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="mt-1 h-3 w-24" />
                  </div>
                </div>
                <Skeleton className="h-5 w-24 rounded-full" />
                <Skeleton className="h-4 w-12" />
                <Skeleton className="h-4 w-12" />
                <Skeleton className="h-4 w-12" />
                <Skeleton className="h-4 w-12" />
                <Skeleton className="h-8 w-20 rounded-md" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ==========================================
// 4. SHOWROOM TARGET SKELETON
// ==========================================
export function ShowroomTargetSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Skeleton className="mb-2 h-3.5 w-44" />
          <Skeleton className="h-8 w-60" />
          <Skeleton className="mt-1.5 h-4 w-[420px] max-w-full" />
        </div>
        <Skeleton className="h-9 w-44 rounded-md" />
      </div>

      {/* 4 KPI Cards */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="shadow-none">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <Skeleton className="h-3.5 w-28" />
                <Skeleton className="size-8 rounded-lg" />
              </div>
              <Skeleton className="mt-3 h-7 w-28" />
              <Skeleton className="mt-2 h-3 w-36" />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Target Charts & Summary */}
      <div className="grid gap-4 xl:grid-cols-12">
        <Card className="shadow-none xl:col-span-7">
          <CardHeader className="border-b px-5 py-4">
            <Skeleton className="h-4 w-40" />
          </CardHeader>
          <CardContent className="p-5">
            <Skeleton className="h-[280px] w-full rounded-md" />
          </CardContent>
        </Card>

        <Card className="shadow-none xl:col-span-5">
          <CardHeader className="border-b px-5 py-4">
            <Skeleton className="h-4 w-36" />
          </CardHeader>
          <CardContent className="space-y-4 p-5">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="space-y-1.5">
                <div className="flex justify-between">
                  <Skeleton className="h-3.5 w-28" />
                  <Skeleton className="h-3.5 w-16" />
                </div>
                <Skeleton className="h-2 w-full rounded-full" />
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* Breakdown Table */}
      <Card className="overflow-hidden shadow-none">
        <CardHeader className="border-b px-5 py-4">
          <Skeleton className="h-4 w-48" />
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center justify-between px-4 py-3.5">
                <div className="flex items-center gap-3">
                  <Skeleton className="size-8 rounded-full" />
                  <Skeleton className="h-4 w-36" />
                </div>
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-6 w-16 rounded-full" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ==========================================
// 5. GM SALES ANALYTICS SKELETON
// ==========================================
export function GmSalesAnalyticsSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Skeleton className="mb-2 h-3.5 w-48" />
          <Skeleton className="h-8 w-64" />
          <Skeleton className="mt-1.5 h-4 w-[450px] max-w-full" />
        </div>
        <Skeleton className="h-9 w-44 rounded-md" />
      </div>

      {/* 5 KPI Cards */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Card key={i} className="shadow-none">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <Skeleton className="h-3.5 w-20" />
                <Skeleton className="size-8 rounded-lg" />
              </div>
              <Skeleton className="mt-3 h-7 w-16" />
              <Skeleton className="mt-2 h-3 w-28" />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* 12-col Chart Grid: Daily Trend (7) + Funnel (5) */}
      <div className="grid gap-5 xl:grid-cols-12">
        <Card className="shadow-none xl:col-span-7">
          <CardHeader className="border-b px-5 py-4">
            <Skeleton className="h-4 w-32" />
          </CardHeader>
          <CardContent className="p-5">
            <Skeleton className="h-[320px] w-full rounded-md" />
          </CardContent>
        </Card>

        <Card className="shadow-none xl:col-span-5">
          <CardHeader className="border-b px-5 py-4">
            <Skeleton className="h-4 w-40" />
          </CardHeader>
          <CardContent className="p-5">
            <Skeleton className="h-[320px] w-full rounded-md" />
          </CardContent>
        </Card>
      </div>

      {/* Branch Table */}
      <Card className="overflow-hidden shadow-none">
        <CardHeader className="border-b px-5 py-4">
          <Skeleton className="h-4 w-44" />
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y">
            <div className="flex items-center justify-between bg-slate-50/50 px-4 py-3">
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="h-3.5 w-16" />
              <Skeleton className="h-3.5 w-16" />
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className="h-3.5 w-20" />
            </div>
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center justify-between px-4 py-3.5">
                <Skeleton className="h-4 w-36" />
                <Skeleton className="h-4 w-12" />
                <Skeleton className="h-4 w-12" />
                <Skeleton className="h-4 w-12" />
                <Skeleton className="h-4 w-12" />
                <Skeleton className="h-4 w-12" />
                <Skeleton className="h-6 w-16 rounded-full" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ==========================================
// 6. GM TARGET SKELETON
// ==========================================
export function GmTargetSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Skeleton className="mb-2 h-3.5 w-44" />
          <Skeleton className="h-8 w-60" />
          <Skeleton className="mt-1.5 h-4 w-[420px] max-w-full" />
        </div>
        <Skeleton className="h-9 w-44 rounded-md" />
      </div>

      {/* 4 KPI Cards */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="shadow-none">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <Skeleton className="h-3.5 w-28" />
                <Skeleton className="size-8 rounded-lg" />
              </div>
              <Skeleton className="mt-3 h-7 w-28" />
              <Skeleton className="mt-2 h-3 w-36" />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Target Progress and Showroom Table */}
      <div className="grid gap-4 xl:grid-cols-12">
        <Card className="shadow-none xl:col-span-6">
          <CardHeader className="border-b px-5 py-4">
            <Skeleton className="h-4 w-40" />
          </CardHeader>
          <CardContent className="p-5">
            <Skeleton className="h-[280px] w-full rounded-md" />
          </CardContent>
        </Card>

        <Card className="shadow-none xl:col-span-6">
          <CardHeader className="border-b px-5 py-4">
            <Skeleton className="h-4 w-44" />
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-center justify-between px-4 py-3.5">
                  <div>
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="mt-1 h-3 w-20" />
                  </div>
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-6 w-16 rounded-full" />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ==========================================
// 7. LEAD ASSIGNMENT SKELETON
// ==========================================
export function LeadAssignmentSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Skeleton className="h-8 w-56" />
          <Skeleton className="mt-1.5 h-4 w-[400px] max-w-full" />
        </div>
        <div className="flex items-center gap-3">
          <Skeleton className="h-9 w-64 rounded-md" />
          <Skeleton className="h-9 w-28 rounded-md" />
        </div>
      </div>

      {/* 2-Column Grid: Queue vs Consultant List */}
      <div className="grid gap-5 lg:grid-cols-12">
        {/* Left: Unassigned Leads Queue */}
        <Card className="shadow-none lg:col-span-7">
          <CardHeader className="flex flex-row items-center justify-between border-b px-5 py-4">
            <div>
              <Skeleton className="h-4 w-36" />
              <Skeleton className="mt-1 h-3 w-24" />
            </div>
            <Skeleton className="h-6 w-16 rounded-full" />
          </CardHeader>
          <CardContent className="space-y-2.5 p-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="rounded-lg border p-3.5">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <Skeleton className="h-4 w-36" />
                    <Skeleton className="mt-1 h-3 w-28" />
                  </div>
                  <Skeleton className="h-5 w-16 rounded-full" />
                </div>
                <div className="mt-3 flex items-center justify-between border-t pt-2.5">
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="h-3 w-20" />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Right: Consultants Assignment Panel */}
        <Card className="shadow-none lg:col-span-5">
          <CardHeader className="border-b px-5 py-4">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="mt-1 h-3 w-32" />
          </CardHeader>
          <CardContent className="space-y-3 p-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center justify-between rounded-lg border p-3.5">
                <div className="flex items-center gap-3">
                  <Skeleton className="size-8 rounded-full" />
                  <div>
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="mt-1 h-3 w-20" />
                  </div>
                </div>
                <Skeleton className="h-6 w-16 rounded-full" />
              </div>
            ))}
            <Skeleton className="mt-4 h-10 w-full rounded-md" />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ==========================================
// 8. MANAGER APPROVALS SKELETON
// ==========================================
export function ManagerApprovalsSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Skeleton className="h-8 w-56" />
          <Skeleton className="mt-1.5 h-4 w-[420px] max-w-full" />
        </div>
        <Skeleton className="h-9 w-64 rounded-md" />
      </div>

      {/* 2-Panel Layout: Pending Queue + Detail/Decision */}
      <div className="grid gap-5 lg:grid-cols-12">
        {/* Left: Approvals List */}
        <Card className="shadow-none lg:col-span-5">
          <CardHeader className="border-b px-5 py-4">
            <Skeleton className="h-4 w-40" />
          </CardHeader>
          <CardContent className="space-y-2.5 p-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="rounded-lg border p-3.5">
                <div className="flex items-start justify-between">
                  <div>
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="mt-1 h-3 w-24" />
                  </div>
                  <Skeleton className="h-5 w-20 rounded-full" />
                </div>
                <div className="mt-2.5 flex items-center justify-between border-t pt-2">
                  <Skeleton className="h-3 w-28" />
                  <Skeleton className="h-3 w-16" />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Right: Approval Details & Actions */}
        <Card className="shadow-none lg:col-span-7">
          <CardHeader className="border-b px-5 py-4">
            <Skeleton className="h-4 w-48" />
          </CardHeader>
          <CardContent className="space-y-4 p-5">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border p-3">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="mt-2 h-5 w-32" />
              </div>
              <div className="rounded-lg border p-3">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="mt-2 h-5 w-32" />
              </div>
            </div>
            <Skeleton className="h-32 w-full rounded-lg" />
            <Skeleton className="h-20 w-full rounded-md" />
            <div className="flex items-center justify-end gap-3 pt-2">
              <Skeleton className="h-9 w-24 rounded-md" />
              <Skeleton className="h-9 w-28 rounded-md" />
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ==========================================
// 9. SALES ESCALATION SKELETON
// ==========================================
export function SalesEscalationSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Skeleton className="h-8 w-52" />
          <Skeleton className="mt-1.5 h-4 w-[400px] max-w-full" />
        </div>
      </div>

      {/* Filter Bar */}
      <Card className="shadow-none">
        <CardContent className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-5">
          <Skeleton className="h-9 w-full rounded-md" />
          <Skeleton className="h-9 w-full rounded-md" />
          <Skeleton className="h-9 w-full rounded-md" />
          <Skeleton className="h-9 w-full rounded-md" />
          <Skeleton className="h-9 w-full rounded-md" />
        </CardContent>
      </Card>

      {/* Table */}
      <Card className="overflow-hidden shadow-none">
        <CardContent className="p-0">
          <div className="divide-y">
            <div className="flex items-center justify-between bg-slate-50/50 px-4 py-3">
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className="h-3.5 w-32" />
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className="h-3.5 w-16" />
            </div>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center justify-between px-4 py-3.5">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-5 w-20 rounded-full" />
                <Skeleton className="h-4 w-44" />
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-5 w-16 rounded-full" />
                <Skeleton className="h-8 w-20 rounded-md" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Pagination */}
      <div className="flex items-center justify-between">
        <Skeleton className="h-4 w-36" />
        <div className="flex items-center gap-2">
          <Skeleton className="size-8 rounded-md" />
          <Skeleton className="size-8 rounded-md" />
        </div>
      </div>
    </div>
  );
}
