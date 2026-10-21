'use client';

import type React from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

// ==========================================
// UNIVERSAL / ROLE-TAILORED TENANT DASHBOARD SKELETON
// ==========================================
export function TenantDashboardSkeleton({ role = 'general' }: { role?: string }) {
  const isCompact = ['finance', 'insurance', 'rto', 'exchange', 'delivery'].includes(role);
  const kpiCount = isCompact ? 5 : 8;
  const panel = (key: string, className: string, body: React.ReactNode) => (
    <Card key={key} className={`overflow-hidden shadow-none ${className}`}>
      <CardHeader className="flex-row items-center justify-between space-y-0 border-b px-4 py-3.5">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3.5 w-16" />
      </CardHeader>
      <CardContent className="p-4">{body}</CardContent>
    </Card>
  );

  return (
    <div className="mx-auto w-full space-y-5">
      <div className="flex flex-col justify-between gap-4 xl:flex-row xl:items-end">
        <div>
          <Skeleton className="h-8 w-64" />
          <Skeleton className="mt-2 h-4 w-[420px] max-w-full" />
        </div>
        <Skeleton className="h-4 w-56" />
      </div>

      <div
        className={`grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4 ${isCompact ? 'xl:grid-cols-5' : 'xl:grid-cols-8'}`}
      >
        {Array.from({ length: kpiCount }).map((_, i) => (
          <Card key={i} className="min-w-0 shadow-none">
            <CardContent className="p-4">
              <div className="flex items-center gap-2.5">
                <Skeleton className="size-8 rounded-lg" />
                <Skeleton className="h-3 w-20" />
              </div>
              <Skeleton className="mx-auto mt-3 h-7 w-14" />
              <Skeleton className="mx-auto mt-3 h-2.5 w-24" />
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-12">
        {panel('trend', 'xl:col-span-7', <Skeleton className="h-[260px] w-full" />)}
        {panel('pipeline', 'xl:col-span-5', <Skeleton className="h-[260px] w-full" />)}
      </div>

      <div className="grid gap-4 xl:grid-cols-12">
        {panel(
          'table',
          'xl:col-span-8',
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>,
        )}
        {panel(
          'side',
          'xl:col-span-4',
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full rounded-lg" />
            ))}
          </div>,
        )}
      </div>
    </div>
  );
}
