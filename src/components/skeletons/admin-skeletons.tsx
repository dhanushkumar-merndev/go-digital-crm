'use client';

import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

// ==========================================
// 1. ADMIN USERS SKELETON
// ==========================================
export function AdminUsersSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Skeleton className="h-8 w-52" />
          <Skeleton className="mt-1.5 h-4 w-[420px] max-w-full" />
        </div>
        <Skeleton className="h-9 w-32 rounded-md" />
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
        <CardContent className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <Skeleton className="h-9 w-full rounded-md" />
          <Skeleton className="h-9 w-full rounded-md" />
          <Skeleton className="h-9 w-full rounded-md" />
          <Skeleton className="h-9 w-full rounded-md" />
        </CardContent>
      </Card>

      {/* Users Table */}
      <Card className="overflow-hidden shadow-none">
        <CardContent className="p-0">
          <div className="divide-y">
            <div className="flex items-center justify-between bg-slate-50/50 px-4 py-3">
              <Skeleton className="h-3.5 w-32" />
              <Skeleton className="h-3.5 w-36" />
              <Skeleton className="h-3.5 w-28" />
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className="h-3.5 w-16" />
            </div>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center justify-between px-4 py-3.5">
                <div className="flex items-center gap-3">
                  <Skeleton className="size-9 rounded-full" />
                  <div>
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="mt-1 h-3 w-24" />
                  </div>
                </div>
                <div className="space-y-1">
                  <Skeleton className="h-3.5 w-40" />
                  <Skeleton className="h-3 w-24" />
                </div>
                <Skeleton className="h-5 w-24 rounded-full" />
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

// ==========================================
// 2. BRANCH & TEAM SKELETON
// ==========================================
export function BranchTeamSkeleton() {
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

      {/* Grid of Branch / Team Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Card key={i} className="shadow-none">
            <CardHeader className="flex flex-row items-center justify-between border-b p-4">
              <div>
                <Skeleton className="h-4 w-36" />
                <Skeleton className="mt-1 h-3 w-20" />
              </div>
              <Skeleton className="h-5 w-16 rounded-full" />
            </CardHeader>
            <CardContent className="space-y-3 p-4">
              <div className="flex items-center justify-between text-xs">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-3 w-28" />
              </div>
              <div className="flex items-center justify-between text-xs">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-3 w-16" />
              </div>
              <div className="flex items-center justify-between border-t pt-3">
                <Skeleton className="h-8 w-20 rounded-md" />
                <Skeleton className="h-8 w-20 rounded-md" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ==========================================
// 3. ROLES & PERMISSIONS SKELETON
// ==========================================
export function RolesPermissionsSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Skeleton className="h-8 w-56" />
          <Skeleton className="mt-1.5 h-4 w-[440px] max-w-full" />
        </div>
        <Skeleton className="h-9 w-32 rounded-md" />
      </div>

      {/* 2-Column Matrix */}
      <div className="grid gap-5 lg:grid-cols-12">
        {/* Left: Roles list */}
        <Card className="shadow-none lg:col-span-4">
          <CardHeader className="border-b px-4 py-3.5">
            <Skeleton className="h-4 w-32" />
          </CardHeader>
          <CardContent className="space-y-2 p-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center justify-between rounded-lg border p-3">
                <div>
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="mt-1 h-3 w-20" />
                </div>
                <Skeleton className="h-5 w-14 rounded-full" />
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Right: Permissions Accordion Matrix */}
        <Card className="shadow-none lg:col-span-8">
          <CardHeader className="flex flex-row items-center justify-between border-b px-5 py-4">
            <div>
              <Skeleton className="h-4 w-44" />
              <Skeleton className="mt-1 h-3 w-32" />
            </div>
            <Skeleton className="h-9 w-28 rounded-md" />
          </CardHeader>
          <CardContent className="space-y-4 p-5">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="rounded-lg border p-4">
                <div className="flex items-center justify-between border-b pb-3">
                  <Skeleton className="h-4 w-36" />
                  <Skeleton className="h-5 w-12 rounded-full" />
                </div>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  {Array.from({ length: 4 }).map((_, j) => (
                    <div key={j} className="flex items-center justify-between rounded border p-2.5">
                      <Skeleton className="h-3.5 w-32" />
                      <Skeleton className="h-5 w-9 rounded-full" />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ==========================================
// 4. CUSTOM FIELDS SKELETON
// ==========================================
export function CustomFieldsSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Skeleton className="h-8 w-48" />
          <Skeleton className="mt-1.5 h-4 w-[400px] max-w-full" />
        </div>
        <Skeleton className="h-9 w-36 rounded-md" />
      </div>

      {/* Module Tabs */}
      <Skeleton className="h-10 w-96 rounded-md" />

      {/* Fields Table */}
      <Card className="overflow-hidden shadow-none">
        <CardContent className="p-0">
          <div className="divide-y">
            <div className="flex items-center justify-between bg-slate-50/50 px-4 py-3">
              <Skeleton className="h-3.5 w-28" />
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className="h-3.5 w-16" />
              <Skeleton className="h-3.5 w-16" />
            </div>
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center justify-between px-4 py-3.5">
                <div>
                  <Skeleton className="h-4 w-36" />
                  <Skeleton className="mt-1 h-3 w-28" />
                </div>
                <Skeleton className="h-5 w-20 rounded-full" />
                <Skeleton className="h-4 w-16" />
                <Skeleton className="h-5 w-10 rounded-full" />
                <Skeleton className="h-5 w-10 rounded-full" />
                <Skeleton className="h-8 w-16 rounded-md" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ==========================================
// 5. MASTER DATA / CRM CONFIG SKELETON
// ==========================================
export function MasterDataSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Skeleton className="h-8 w-56" />
          <Skeleton className="mt-1.5 h-4 w-[420px] max-w-full" />
        </div>
        <Skeleton className="h-9 w-32 rounded-md" />
      </div>

      {/* Entity Tabs */}
      <Skeleton className="h-10 w-[540px] max-w-full rounded-md" />

      {/* Master Data Table */}
      <Card className="overflow-hidden shadow-none">
        <CardContent className="p-0">
          <div className="divide-y">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center justify-between px-4 py-3.5">
                <div className="flex items-center gap-3">
                  <Skeleton className="size-7 rounded-md" />
                  <div>
                    <Skeleton className="h-4 w-36" />
                    <Skeleton className="mt-1 h-3 w-24" />
                  </div>
                </div>
                <Skeleton className="h-4 w-20" />
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
// 6. COMPETITOR CATALOG SKELETON
// ==========================================
export function CompetitorCatalogSkeleton() {
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

      {/* Brand Selector */}
      <Skeleton className="h-10 w-80 rounded-md" />

      {/* Competitor Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Card key={i} className="shadow-none">
            <CardHeader className="border-b p-4">
              <div className="flex items-center justify-between">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-5 w-16 rounded-full" />
              </div>
              <Skeleton className="mt-1.5 h-5 w-40" />
            </CardHeader>
            <CardContent className="space-y-2.5 p-4">
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="h-3.5 w-3/4" />
              <div className="border-t pt-2.5">
                <Skeleton className="h-8 w-full rounded-md" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ==========================================
// 7. TENANT MODULE ENTITLEMENTS SKELETON
// ==========================================
export function TenantModuleEntitlementsSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Skeleton className="h-8 w-60" />
          <Skeleton className="mt-1.5 h-4 w-[420px] max-w-full" />
        </div>
        <Skeleton className="h-9 w-32 rounded-md" />
      </div>

      {/* 3 KPI Cards */}
      <div className="grid gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i} className="shadow-none">
            <CardContent className="p-4">
              <Skeleton className="h-3.5 w-28" />
              <Skeleton className="mt-2.5 h-7 w-20" />
              <Skeleton className="mt-1.5 h-3 w-36" />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Module Grid Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Card key={i} className="shadow-none">
            <CardHeader className="flex flex-row items-center justify-between border-b p-4">
              <div className="flex items-center gap-2.5">
                <Skeleton className="size-8 rounded-lg" />
                <Skeleton className="h-4 w-32" />
              </div>
              <Skeleton className="h-5 w-10 rounded-full" />
            </CardHeader>
            <CardContent className="space-y-2 p-4">
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="h-3.5 w-4/5" />
              <div className="flex items-center justify-between border-t pt-3">
                <Skeleton className="h-5 w-16 rounded-full" />
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
// 8. TENANT TARGET CONFIGURATION SKELETON
// ==========================================
export function TenantTargetConfigurationSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Skeleton className="h-8 w-64" />
          <Skeleton className="mt-1.5 h-4 w-[440px] max-w-full" />
        </div>
        <Skeleton className="h-9 w-36 rounded-md" />
      </div>

      {/* Configuration Form Cards */}
      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="shadow-none">
          <CardHeader className="border-b px-5 py-4">
            <Skeleton className="h-4 w-40" />
          </CardHeader>
          <CardContent className="space-y-4 p-5">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="space-y-1.5">
                <Skeleton className="h-3.5 w-32" />
                <Skeleton className="h-9 w-full rounded-md" />
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="shadow-none">
          <CardHeader className="border-b px-5 py-4">
            <Skeleton className="h-4 w-44" />
          </CardHeader>
          <CardContent className="space-y-4 p-5">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="space-y-1.5">
                <Skeleton className="h-3.5 w-36" />
                <Skeleton className="h-9 w-full rounded-md" />
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ==========================================
// 9. COMPANY COMPLIANCE SKELETON
// ==========================================
export function CompanyComplianceSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Skeleton className="h-8 w-56" />
          <Skeleton className="mt-1.5 h-4 w-[420px] max-w-full" />
        </div>
        <Skeleton className="h-9 w-32 rounded-md" />
      </div>

      {/* Legal Info Card */}
      <Card className="shadow-none">
        <CardHeader className="border-b px-5 py-4">
          <Skeleton className="h-4 w-44" />
        </CardHeader>
        <CardContent className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="space-y-1 rounded-lg border p-3">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-4 w-36" />
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Documents Grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="shadow-none">
            <CardContent className="space-y-3 p-4">
              <div className="flex items-center justify-between">
                <Skeleton className="size-9 rounded-lg" />
                <Skeleton className="h-5 w-16 rounded-full" />
              </div>
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-8 w-full rounded-md" />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ==========================================
// 10. SYSTEM HEALTH SKELETON
// ==========================================
export function SystemHealthSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Skeleton className="h-8 w-48" />
          <Skeleton className="mt-1.5 h-4 w-[380px] max-w-full" />
        </div>
        <Skeleton className="h-9 w-32 rounded-md" />
      </div>

      {/* 4 Health KPI Cards */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="shadow-none">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <Skeleton className="h-3.5 w-28" />
                <Skeleton className="size-6 rounded-full" />
              </div>
              <Skeleton className="mt-3 h-7 w-20" />
              <Skeleton className="mt-2 h-3 w-32" />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Latency Chart */}
      <Card className="shadow-none">
        <CardHeader className="border-b px-5 py-4">
          <Skeleton className="h-4 w-36" />
        </CardHeader>
        <CardContent className="p-5">
          <Skeleton className="h-[260px] w-full rounded-md" />
        </CardContent>
      </Card>
    </div>
  );
}

// ==========================================
// 11. AUTOMATION WORKSPACE SKELETON
// ==========================================
export function AutomationWorkspaceSkeleton() {
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

      {/* Rules Table */}
      <Card className="overflow-hidden shadow-none">
        <CardContent className="p-0">
          <div className="divide-y">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center justify-between px-4 py-3.5">
                <div className="flex items-center gap-3">
                  <Skeleton className="size-8 rounded-lg" />
                  <div>
                    <Skeleton className="h-4 w-44" />
                    <Skeleton className="mt-1 h-3 w-32" />
                  </div>
                </div>
                <Skeleton className="h-5 w-24 rounded-full" />
                <Skeleton className="h-5 w-10 rounded-full" />
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
// 12. AUTOMATION RULE DETAIL SKELETON
// ==========================================
export function AutomationRuleDetailSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Skeleton className="size-8 rounded-md" />
          <Skeleton className="h-7 w-60" />
        </div>
        <Skeleton className="h-9 w-28 rounded-md" />
      </div>

      {/* Visual Workflow Canvas */}
      <div className="grid gap-5 lg:grid-cols-12">
        <div className="space-y-4 lg:col-span-8">
          <Card className="shadow-none">
            <CardHeader className="border-b px-4 py-3">
              <Skeleton className="h-4 w-32" />
            </CardHeader>
            <CardContent className="space-y-3 p-4">
              <Skeleton className="h-14 w-full rounded-lg" />
              <div className="mx-auto h-6 w-0.5 bg-slate-200" />
              <Skeleton className="h-14 w-full rounded-lg" />
              <div className="mx-auto h-6 w-0.5 bg-slate-200" />
              <Skeleton className="h-14 w-full rounded-lg" />
            </CardContent>
          </Card>
        </div>

        <Card className="shadow-none lg:col-span-4">
          <CardHeader className="border-b px-4 py-3">
            <Skeleton className="h-4 w-36" />
          </CardHeader>
          <CardContent className="space-y-3 p-4">
            <Skeleton className="h-9 w-full rounded-md" />
            <Skeleton className="h-9 w-full rounded-md" />
            <Skeleton className="h-20 w-full rounded-md" />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ==========================================
// 13. TEMPLATE WORKSPACE SKELETON
// ==========================================
export function TemplateWorkspaceSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Skeleton className="h-8 w-44" />
          <Skeleton className="mt-1.5 h-4 w-[400px] max-w-full" />
        </div>
        <Skeleton className="h-9 w-36 rounded-md" />
      </div>

      {/* Tabs */}
      <Skeleton className="h-10 w-72 rounded-md" />

      {/* Templates Grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Card key={i} className="shadow-none">
            <CardHeader className="border-b p-4">
              <div className="flex items-center justify-between">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-5 w-16 rounded-full" />
              </div>
            </CardHeader>
            <CardContent className="space-y-3 p-4">
              <Skeleton className="h-20 w-full rounded-md" />
              <div className="flex items-center justify-between border-t pt-2.5">
                <Skeleton className="h-3 w-20" />
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
// 14. SECURITY WORKSPACE SKELETON
// ==========================================
export function SecurityWorkspaceSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Skeleton className="h-8 w-48" />
          <Skeleton className="mt-1.5 h-4 w-[400px] max-w-full" />
        </div>
        <Skeleton className="h-9 w-32 rounded-md" />
      </div>

      {/* 3 KPI Cards */}
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

      {/* Security Policies */}
      <Card className="shadow-none">
        <CardHeader className="border-b px-5 py-4">
          <Skeleton className="h-4 w-40" />
        </CardHeader>
        <CardContent className="space-y-4 p-5">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex items-center justify-between rounded-lg border p-4">
              <div>
                <Skeleton className="h-4 w-44" />
                <Skeleton className="mt-1 h-3 w-64" />
              </div>
              <Skeleton className="h-5 w-10 rounded-full" />
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

// ==========================================
// 15. AUDIT LOG WORKSPACE SKELETON
// ==========================================
export function AuditLogWorkspaceSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Skeleton className="h-8 w-44" />
          <Skeleton className="mt-1.5 h-4 w-[400px] max-w-full" />
        </div>
        <Skeleton className="h-9 w-32 rounded-md" />
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

      {/* Audit Logs Table */}
      <Card className="overflow-hidden shadow-none">
        <CardContent className="p-0">
          <div className="divide-y">
            {Array.from({ length: 7 }).map((_, i) => (
              <div key={i} className="flex items-center justify-between px-4 py-3.5">
                <Skeleton className="h-4 w-36" />
                <div className="flex items-center gap-2">
                  <Skeleton className="size-7 rounded-full" />
                  <Skeleton className="h-4 w-28" />
                </div>
                <Skeleton className="h-5 w-20 rounded-full" />
                <Skeleton className="h-4 w-40" />
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
// 16. OWNER AI BUSINESS SUMMARY SKELETON
// ==========================================
export function OwnerAiBusinessSummarySkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Skeleton className="h-8 w-60" />
          <Skeleton className="mt-1.5 h-4 w-[420px] max-w-full" />
        </div>
        <Skeleton className="h-9 w-44 rounded-md" />
      </div>

      {/* AI Insight Callout Card */}
      <Card className="border-indigo-100 bg-indigo-50/40 shadow-none">
        <CardContent className="space-y-2 p-5">
          <div className="flex items-center gap-2">
            <Skeleton className="size-6 rounded-md" />
            <Skeleton className="h-4 w-40" />
          </div>
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
        </CardContent>
      </Card>

      {/* 4 KPI Cards */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="shadow-none">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <Skeleton className="h-3.5 w-28" />
                <Skeleton className="size-8 rounded-lg" />
              </div>
              <Skeleton className="mt-3 h-7 w-24" />
              <Skeleton className="mt-2 h-3 w-36" />
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
// 17. INTEGRATION WORKSPACE SKELETON
// ==========================================
export function IntegrationWorkspaceSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Skeleton className="h-8 w-48" />
          <Skeleton className="mt-1.5 h-4 w-[400px] max-w-full" />
        </div>
        <Skeleton className="h-9 w-36 rounded-md" />
      </div>

      {/* Category Tabs */}
      <Skeleton className="h-10 w-96 rounded-md" />

      {/* Integration Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Card key={i} className="shadow-none">
            <CardHeader className="flex flex-row items-center justify-between border-b p-4">
              <div className="flex items-center gap-3">
                <Skeleton className="size-10 rounded-lg" />
                <div>
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="mt-1 h-3 w-20" />
                </div>
              </div>
              <Skeleton className="h-5 w-16 rounded-full" />
            </CardHeader>
            <CardContent className="space-y-3 p-4">
              <Skeleton className="h-3.5 w-full" />
              <div className="flex items-center justify-between border-t pt-2.5">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-8 w-20 rounded-md" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ==========================================
// 18. NOTIFICATION WORKSPACE SKELETON
// ==========================================
export function NotificationWorkspaceSkeleton() {
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

      {/* Notifications List */}
      <Card className="overflow-hidden shadow-none">
        <CardContent className="p-0">
          <div className="divide-y">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-start justify-between p-4">
                <div className="flex items-start gap-3">
                  <Skeleton className="size-8 rounded-full" />
                  <div>
                    <Skeleton className="h-4 w-48" />
                    <Skeleton className="mt-1 h-3 w-64" />
                    <Skeleton className="mt-1.5 h-2.5 w-24" />
                  </div>
                </div>
                <Skeleton className="h-5 w-16 rounded-full" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ==========================================
// 19. REPORT EXPORT WORKSPACE SKELETON
// ==========================================
export function ReportExportWorkspaceSkeleton() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Skeleton className="h-8 w-44" />
          <Skeleton className="mt-1.5 h-4 w-[400px] max-w-full" />
        </div>
        <Skeleton className="h-9 w-32 rounded-md" />
      </div>

      {/* Filter and Export Form */}
      <Card className="shadow-none">
        <CardContent className="grid gap-4 p-5 sm:grid-cols-3">
          <Skeleton className="h-9 w-full rounded-md" />
          <Skeleton className="h-9 w-full rounded-md" />
          <Skeleton className="h-9 w-full rounded-md" />
        </CardContent>
      </Card>

      {/* Recent Exports Table */}
      <Card className="overflow-hidden shadow-none">
        <CardHeader className="border-b px-5 py-4">
          <Skeleton className="h-4 w-36" />
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center justify-between px-4 py-3.5">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-5 w-20 rounded-full" />
                <Skeleton className="h-8 w-24 rounded-md" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
