'use client';

import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

// ==========================================
// 1. PLATFORM DASHBOARD SKELETON
// ==========================================
export function PlatformDashboardSkeleton() {
  return (
    <div className="mx-auto max-w-[1600px] space-y-6">
      {/* Header */}
      <div>
        <Skeleton className="h-8 w-56" />
        <Skeleton className="mt-1.5 h-4 w-[420px] max-w-full" />
      </div>

      {/* 4 KPI Cards */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="shadow-none">
            <CardContent className="p-4">
              <Skeleton className="h-3.5 w-28" />
              <Skeleton className="mt-3 h-7 w-20" />
              <Skeleton className="mt-2 h-3 w-36" />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* 12-col Grid: Activity Trend (7) + Tenant Statuses Donut (5) */}
      <div className="grid gap-6 xl:grid-cols-12">
        <Card className="shadow-none xl:col-span-7">
          <CardHeader className="border-b px-5 py-4">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="mt-1 h-3 w-48" />
          </CardHeader>
          <CardContent className="p-5">
            <Skeleton className="h-[280px] w-full rounded-md" />
          </CardContent>
        </Card>

        <Card className="shadow-none xl:col-span-5">
          <CardHeader className="border-b px-5 py-4">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="mt-1 h-3 w-40" />
          </CardHeader>
          <CardContent className="flex flex-col items-center justify-center p-5">
            <Skeleton className="size-40 rounded-full" />
            <div className="mt-4 grid w-full grid-cols-2 gap-2">
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-full" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Requires Attention */}
      <Card className="shadow-none">
        <CardHeader className="flex flex-row items-center justify-between border-b px-5 py-4">
          <div>
            <Skeleton className="h-4 w-36" />
            <Skeleton className="mt-1 h-3 w-52" />
          </div>
          <Skeleton className="h-8 w-28 rounded-md" />
        </CardHeader>
        <CardContent className="grid gap-3 p-5 md:grid-cols-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="flex items-start gap-3 rounded-lg border p-4">
              <Skeleton className="size-9 rounded-lg" />
              <div className="space-y-1">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-56" />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

// ==========================================
// 2. DEALERSHIP WORKSPACE SKELETON
// ==========================================
export function DealershipWorkspaceSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Skeleton className="h-8 w-52" />
          <Skeleton className="mt-1.5 h-4 w-[400px] max-w-full" />
        </div>
        <Skeleton className="h-9 w-36 rounded-md" />
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

      {/* Filter Bar */}
      <Card className="shadow-none">
        <CardContent className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <Skeleton className="h-9 w-full rounded-md" />
          <Skeleton className="h-9 w-full rounded-md" />
          <Skeleton className="h-9 w-full rounded-md" />
          <Skeleton className="h-9 w-full rounded-md" />
        </CardContent>
      </Card>

      {/* Dealerships Table */}
      <Card className="overflow-hidden shadow-none">
        <CardContent className="p-0">
          <div className="divide-y">
            <div className="flex items-center justify-between bg-slate-50/50 px-4 py-3">
              <Skeleton className="h-3.5 w-36" />
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="h-3.5 w-28" />
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="h-3.5 w-16" />
            </div>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center justify-between px-4 py-3.5">
                <div>
                  <Skeleton className="h-4 w-44" />
                  <Skeleton className="mt-1 h-3 w-28" />
                </div>
                <Skeleton className="h-5 w-20 rounded-full" />
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-5 w-16 rounded-full" />
                <Skeleton className="h-4 w-24" />
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
// 3. DEALERSHIP DETAIL SKELETON
// ==========================================
export function DealershipDetailSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Skeleton className="size-9 rounded-md" />
          <div>
            <Skeleton className="h-7 w-60" />
            <Skeleton className="mt-1 h-3.5 w-32" />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="h-9 w-24 rounded-md" />
          <Skeleton className="h-9 w-24 rounded-md" />
        </div>
      </div>

      {/* Tabs */}
      <Skeleton className="h-10 w-[480px] max-w-full rounded-md" />

      {/* Detail Content Grid */}
      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="shadow-none">
          <CardHeader className="border-b px-5 py-4">
            <Skeleton className="h-4 w-36" />
          </CardHeader>
          <CardContent className="space-y-4 p-5">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex justify-between border-b pb-3">
                <Skeleton className="h-3.5 w-28" />
                <Skeleton className="h-3.5 w-36" />
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="shadow-none">
          <CardHeader className="border-b px-5 py-4">
            <Skeleton className="h-4 w-36" />
          </CardHeader>
          <CardContent className="space-y-4 p-5">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex justify-between border-b pb-3">
                <Skeleton className="h-3.5 w-28" />
                <Skeleton className="h-3.5 w-36" />
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ==========================================
// 4. ONBOARDING REVIEW SKELETON
// ==========================================
export function OnboardingReviewSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Skeleton className="h-8 w-56" />
          <Skeleton className="mt-1.5 h-4 w-[400px] max-w-full" />
        </div>
      </div>

      {/* 3 KPI Cards */}
      <div className="grid gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i} className="shadow-none">
            <CardContent className="p-4">
              <Skeleton className="h-3.5 w-28" />
              <Skeleton className="mt-2.5 h-7 w-16" />
              <Skeleton className="mt-1.5 h-3 w-32" />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Review Queue Cards */}
      <div className="space-y-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i} className="shadow-none">
            <CardHeader className="flex flex-row items-center justify-between border-b p-4">
              <div>
                <Skeleton className="h-4 w-44" />
                <Skeleton className="mt-1 h-3 w-32" />
              </div>
              <Skeleton className="h-5 w-20 rounded-full" />
            </CardHeader>
            <CardContent className="space-y-3 p-4">
              <div className="grid gap-2 sm:grid-cols-3">
                <Skeleton className="h-3 w-28" />
                <Skeleton className="h-3 w-28" />
                <Skeleton className="h-3 w-28" />
              </div>
              <div className="flex items-center justify-end gap-3 border-t pt-3">
                <Skeleton className="h-8 w-24 rounded-md" />
                <Skeleton className="h-8 w-24 rounded-md" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ==========================================
// 5. SUBSCRIPTION PLAN SKELETON
// ==========================================
export function SubscriptionPlanSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Skeleton className="h-8 w-52" />
          <Skeleton className="mt-1.5 h-4 w-[400px] max-w-full" />
        </div>
        <Skeleton className="h-9 w-32 rounded-md" />
      </div>

      {/* Plan Pricing Cards */}
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i} className="shadow-none">
            <CardHeader className="border-b p-5">
              <Skeleton className="h-5 w-28" />
              <Skeleton className="mt-3 h-8 w-36" />
              <Skeleton className="mt-1.5 h-3.5 w-44" />
            </CardHeader>
            <CardContent className="space-y-3 p-5">
              {Array.from({ length: 5 }).map((_, j) => (
                <div key={j} className="flex items-center gap-2">
                  <Skeleton className="size-4 rounded-full" />
                  <Skeleton className="h-3.5 w-40" />
                </div>
              ))}
              <div className="border-t pt-4">
                <Skeleton className="h-9 w-full rounded-md" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ==========================================
// 6. MODULE WORKSPACE SKELETON
// ==========================================
export function ModuleWorkspaceSkeleton() {
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

      {/* Module Grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Card key={i} className="shadow-none">
            <CardHeader className="flex flex-row items-center justify-between border-b p-4">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-5 w-14 rounded-full" />
            </CardHeader>
            <CardContent className="space-y-2 p-4">
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="h-3.5 w-3/4" />
              <div className="flex items-center justify-between border-t pt-2.5">
                <Skeleton className="h-3 w-24" />
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
// 7. PLATFORM INTEGRATION SKELETON
// ==========================================
export function PlatformIntegrationSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      {/* Header */}
      <div>
        <Skeleton className="h-8 w-64" />
        <Skeleton className="mt-1.5 h-4 w-[420px] max-w-full" />
      </div>

      {/* Provider Health Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="shadow-none">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <Skeleton className="size-9 rounded-lg" />
                <Skeleton className="h-5 w-16 rounded-full" />
              </div>
              <Skeleton className="mt-3 h-5 w-32" />
              <Skeleton className="mt-1.5 h-3 w-24" />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Webhook Monitor Table */}
      <Card className="overflow-hidden shadow-none">
        <CardHeader className="border-b px-5 py-4">
          <Skeleton className="h-4 w-44" />
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center justify-between px-4 py-3.5">
                <Skeleton className="h-4 w-36" />
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-5 w-16 rounded-full" />
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
// 8. PLATFORM AI USAGE SKELETON
// ==========================================
export function PlatformAiUsageSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Skeleton className="h-8 w-56" />
          <Skeleton className="mt-1.5 h-4 w-[400px] max-w-full" />
        </div>
        <Skeleton className="h-9 w-44 rounded-md" />
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

      {/* Usage Charts */}
      <Card className="shadow-none">
        <CardHeader className="border-b px-5 py-4">
          <Skeleton className="h-4 w-40" />
        </CardHeader>
        <CardContent className="p-5">
          <Skeleton className="h-[280px] w-full rounded-md" />
        </CardContent>
      </Card>
    </div>
  );
}

// ==========================================
// 9. PLATFORM HEALTH SKELETON
// ==========================================
export function PlatformHealthSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <Skeleton className="h-8 w-48" />
          <Skeleton className="mt-1.5 h-4 w-[380px] max-w-full" />
        </div>
        <Skeleton className="h-9 w-32 rounded-md" />
      </div>

      {/* Health Grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="shadow-none">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="size-6 rounded-full" />
              </div>
              <Skeleton className="mt-3 h-6 w-20" />
              <Skeleton className="mt-2 h-3 w-28" />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ==========================================
// 10. PLATFORM USER ACCESS SKELETON
// ==========================================
export function PlatformUserAccessSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Skeleton className="h-8 w-52" />
          <Skeleton className="mt-1.5 h-4 w-[400px] max-w-full" />
        </div>
        <Skeleton className="h-9 w-32 rounded-md" />
      </div>

      {/* Users Table */}
      <Card className="overflow-hidden shadow-none">
        <CardContent className="p-0">
          <div className="divide-y">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center justify-between px-4 py-3.5">
                <div className="flex items-center gap-3">
                  <Skeleton className="size-9 rounded-full" />
                  <div>
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="mt-1 h-3 w-40" />
                  </div>
                </div>
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
// 11. RETENTION WORKSPACE SKELETON
// ==========================================
export function RetentionWorkspaceSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      {/* Header */}
      <div>
        <Skeleton className="h-8 w-60" />
        <Skeleton className="mt-1.5 h-4 w-[440px] max-w-full" />
      </div>

      {/* Retention Policies Table */}
      <Card className="overflow-hidden shadow-none">
        <CardHeader className="border-b px-5 py-4">
          <Skeleton className="h-4 w-44" />
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center justify-between px-4 py-3.5">
                <Skeleton className="h-4 w-36" />
                <Skeleton className="h-4 w-28" />
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
// 12. SUPPORT SESSION SKELETON
// ==========================================
export function SupportSessionSkeleton() {
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

      {/* Active Session Banner Card */}
      <Card className="border-blue-100 bg-blue-50/40 shadow-none">
        <CardContent className="flex items-center justify-between p-5">
          <div className="space-y-1">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3 w-64" />
          </div>
          <Skeleton className="h-8 w-28 rounded-md" />
        </CardContent>
      </Card>

      {/* History Table */}
      <Card className="overflow-hidden shadow-none">
        <CardHeader className="border-b px-5 py-4">
          <Skeleton className="h-4 w-40" />
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center justify-between px-4 py-3.5">
                <Skeleton className="h-4 w-36" />
                <Skeleton className="h-4 w-44" />
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-5 w-16 rounded-full" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
