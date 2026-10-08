'use client';

import { ChevronRight } from 'lucide-react';
import { SalesHandoffReport } from './sales-handoff-report';

/**
 * Client Admin has no sales Performance page of its own. This page carries the
 * organization-wide telecaller-to-sales handoff report, broken down by branch.
 */
export function ClientAdminBranchPerformance() {
  return (
    <div className="mx-auto max-w-[1800px] space-y-4">
      <div>
        <div className="mb-2 flex items-center gap-1 text-xs text-muted-foreground">
          <span className="text-primary">Dashboard</span>
          <ChevronRight className="size-3" />
          <span>Branch Performance</span>
        </div>
        <h1 className="text-2xl font-bold tracking-tight md:text-[28px]">Branch Performance</h1>
        <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">
          How each branch&apos;s telecallers hand qualified leads to Sales Consultants, and how many
          of those leads reach a booking. Click a branch, telecaller or consultant to narrow the
          view.
        </p>
      </div>
      <SalesHandoffReport preset="ORGANIZATION" leadBasePath="/client-admin/leads" />
    </div>
  );
}
