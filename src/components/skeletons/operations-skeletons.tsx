'use client';

import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

// ==========================================
// 1. OPERATIONAL CASE WORKSPACE SKELETON
// (Finance, Insurance, RTO, Exchange, Operations)
// ==========================================
export function OperationalCaseWorkspaceSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Skeleton className="h-8 w-56" />
          <Skeleton className="mt-1.5 h-4 w-[420px] max-w-full" />
        </div>
        <Skeleton className="h-9 w-36 rounded-md" />
      </div>

      {/* 5 KPI Cards */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Card key={i} className="shadow-none">
            <CardContent className="p-4">
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="mt-3 h-7 w-16" />
              <Skeleton className="mt-2 h-3 w-32" />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* View Tabs */}
      <Skeleton className="h-10 w-96 rounded-md" />

      {/* Filter Bar */}
      <Card className="shadow-none">
        <CardContent className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <Skeleton className="h-9 w-full rounded-md" />
          <Skeleton className="h-9 w-full rounded-md" />
          <Skeleton className="h-9 w-full rounded-md" />
          <Skeleton className="h-9 w-full rounded-md" />
        </CardContent>
      </Card>

      {/* Cases Table */}
      <Card className="overflow-hidden shadow-none">
        <CardContent className="p-0">
          <div className="divide-y">
            <div className="flex items-center justify-between bg-slate-50/50 px-4 py-3">
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="h-3.5 w-32" />
              <Skeleton className="h-3.5 w-28" />
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className="h-3.5 w-16" />
            </div>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center justify-between px-4 py-3.5">
                <Skeleton className="h-4 w-28" />
                <div className="space-y-1">
                  <Skeleton className="h-4 w-36" />
                  <Skeleton className="h-3 w-24" />
                </div>
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-5 w-20 rounded-full" />
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

// ==========================================
// 2. INVENTORY WORKSPACE SKELETON
// ==========================================
export function InventoryWorkspaceSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Skeleton className="h-8 w-52" />
          <Skeleton className="mt-1.5 h-4 w-[420px] max-w-full" />
        </div>
        <Skeleton className="h-9 w-36 rounded-md" />
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
              <Skeleton className="mt-3 h-7 w-16" />
              <Skeleton className="mt-2 h-3 w-32" />
            </CardContent>
          </Card>
        ))}
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

      {/* Stock Units Table */}
      <Card className="overflow-hidden shadow-none">
        <CardContent className="p-0">
          <div className="divide-y">
            <div className="flex items-center justify-between bg-slate-50/50 px-4 py-3">
              <Skeleton className="h-3.5 w-32" />
              <Skeleton className="h-3.5 w-36" />
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className="h-3.5 w-16" />
            </div>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center justify-between px-4 py-3.5">
                <div>
                  <Skeleton className="h-4 w-36" />
                  <Skeleton className="mt-1 h-3 w-28" />
                </div>
                <div className="space-y-1">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-3 w-20" />
                </div>
                <Skeleton className="h-5 w-20 rounded-full" />
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-4 w-16" />
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

// ==========================================
// 3. DELIVERY FEEDBACK SKELETON
// ==========================================
export function DeliveryFeedbackSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Skeleton className="h-8 w-56" />
          <Skeleton className="mt-1.5 h-4 w-[400px] max-w-full" />
        </div>
        <Skeleton className="h-9 w-32 rounded-md" />
      </div>

      {/* 3 Rating KPI Cards */}
      <div className="grid gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i} className="shadow-none">
            <CardContent className="p-4">
              <Skeleton className="h-3.5 w-28" />
              <Skeleton className="mt-2.5 h-7 w-20" />
              <Skeleton className="mt-1.5 h-3 w-32" />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Feedback Feed */}
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="shadow-none">
            <CardContent className="space-y-2.5 p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Skeleton className="size-8 rounded-full" />
                  <Skeleton className="h-4 w-32" />
                </div>
                <Skeleton className="h-5 w-24 rounded-full" />
              </div>
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="h-3.5 w-4/5" />
              <div className="flex items-center justify-between border-t pt-2.5 text-xs">
                <Skeleton className="h-3 w-28" />
                <Skeleton className="h-3 w-20" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ==========================================
// 4. CUSTOMER CARE WORKSPACE SKELETON
// ==========================================
export function CustomerCareWorkspaceSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Skeleton className="h-8 w-60" />
          <Skeleton className="mt-1.5 h-4 w-[440px] max-w-full" />
        </div>
        <Skeleton className="h-9 w-36 rounded-md" />
      </div>

      {/* 7 KPI Cards */}
      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-7">
        {Array.from({ length: 7 }).map((_, i) => (
          <Card key={i} className="shadow-none">
            <CardContent className="p-3">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="mt-2 h-6 w-12" />
              <Skeleton className="mt-1 h-2.5 w-24" />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* View Tabs */}
      <Skeleton className="h-10 w-[520px] max-w-full rounded-md" />

      {/* Filter Bar */}
      <Card className="shadow-none">
        <CardContent className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <Skeleton className="h-9 w-full rounded-md" />
          <Skeleton className="h-9 w-full rounded-md" />
          <Skeleton className="h-9 w-full rounded-md" />
          <Skeleton className="h-9 w-full rounded-md" />
        </CardContent>
      </Card>

      {/* Customer Cases Table */}
      <Card className="overflow-hidden shadow-none">
        <CardContent className="p-0">
          <div className="divide-y">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center justify-between px-4 py-3.5">
                <Skeleton className="h-4 w-24" />
                <div className="space-y-1">
                  <Skeleton className="h-4 w-36" />
                  <Skeleton className="h-3 w-24" />
                </div>
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-5 w-20 rounded-full" />
                <Skeleton className="h-5 w-16 rounded-full" />
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
// 5. CUSTOMER RELATIONSHIP DASHBOARD SKELETON
// ==========================================
export function CustomerRelationshipDashboardSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Skeleton className="h-8 w-64" />
          <Skeleton className="mt-1.5 h-4 w-[420px] max-w-full" />
        </div>
        <Skeleton className="h-9 w-44 rounded-md" />
      </div>

      {/* 4 KPI Cards */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="shadow-none">
            <CardContent className="p-4">
              <Skeleton className="h-3.5 w-28" />
              <Skeleton className="mt-3 h-7 w-20" />
              <Skeleton className="mt-2 h-3 w-32" />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Charts */}
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
          <CardContent className="p-5">
            <Skeleton className="h-[280px] w-full rounded-md" />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ==========================================
// 6. MARKETING WORKSPACE SKELETON
// ==========================================
export function MarketingWorkspaceSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Skeleton className="h-8 w-56" />
          <Skeleton className="mt-1.5 h-4 w-[420px] max-w-full" />
        </div>
        <Skeleton className="h-9 w-36 rounded-md" />
      </div>

      {/* 4 KPI Cards */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="shadow-none">
            <CardContent className="p-4">
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="mt-3 h-7 w-20" />
              <Skeleton className="mt-2 h-3 w-32" />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* View Tabs */}
      <Skeleton className="h-10 w-96 rounded-md" />

      {/* Trend + Source Charts */}
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
          <CardContent className="p-5">
            <Skeleton className="h-[280px] w-full rounded-md" />
          </CardContent>
        </Card>
      </div>

      {/* Marketing Table */}
      <Card className="overflow-hidden shadow-none">
        <CardContent className="p-0">
          <div className="divide-y">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center justify-between px-4 py-3.5">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-5 w-20 rounded-full" />
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-4 w-24" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ==========================================
// 7. MARKETING AUTOMATION SKELETON
// ==========================================
export function MarketingAutomationSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Skeleton className="h-8 w-60" />
          <Skeleton className="mt-1.5 h-4 w-[420px] max-w-full" />
        </div>
        <Skeleton className="h-9 w-36 rounded-md" />
      </div>

      {/* Tabs */}
      <Skeleton className="h-10 w-64 rounded-md" />

      {/* Flow Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Card key={i} className="shadow-none">
            <CardHeader className="flex flex-row items-center justify-between border-b p-4">
              <div>
                <Skeleton className="h-4 w-36" />
                <Skeleton className="mt-1 h-3 w-24" />
              </div>
              <Skeleton className="h-5 w-10 rounded-full" />
            </CardHeader>
            <CardContent className="space-y-3 p-4">
              <Skeleton className="h-3.5 w-full" />
              <div className="flex items-center justify-between border-t pt-2.5">
                <Skeleton className="h-3 w-28" />
                <Skeleton className="h-8 w-16 rounded-md" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ==========================================
// 8. AI IMAGE CREATION SKELETON
// ==========================================
export function AiImageCreationSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      {/* Header */}
      <div>
        <Skeleton className="h-8 w-56" />
        <Skeleton className="mt-1.5 h-4 w-[420px] max-w-full" />
      </div>

      {/* 2-Column Grid: Form vs Asset Gallery */}
      <div className="grid gap-5 lg:grid-cols-12">
        <Card className="shadow-none lg:col-span-5">
          <CardHeader className="border-b px-5 py-4">
            <Skeleton className="h-4 w-36" />
          </CardHeader>
          <CardContent className="space-y-4 p-5">
            <div className="space-y-1.5">
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="h-28 w-full rounded-md" />
            </div>
            <div className="space-y-1.5">
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="h-9 w-full rounded-md" />
            </div>
            <Skeleton className="h-10 w-full rounded-md" />
          </CardContent>
        </Card>

        <Card className="shadow-none lg:col-span-7">
          <CardHeader className="border-b px-5 py-4">
            <Skeleton className="h-4 w-40" />
          </CardHeader>
          <CardContent className="p-5">
            <div className="grid gap-4 sm:grid-cols-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="aspect-square rounded-lg border">
                  <Skeleton className="h-full w-full rounded-lg" />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
