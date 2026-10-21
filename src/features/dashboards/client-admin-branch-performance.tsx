'use client';

import type { PageSpec } from '@/lib/domain';
import { PageHeader } from '@/components/shared/page-header';
import { SalesHandoffReport } from './sales-handoff-report';

/**
 * Client Admin has no sales Performance page of its own. This page carries the
 * organization-wide telecaller-to-sales handoff report, broken down by branch.
 */
export function ClientAdminBranchPerformance({ spec }: { spec: PageSpec }) {
  return (
    <div className="mx-auto w-full space-y-5">
      <PageHeader
        spec={{ ...spec, primaryAction: undefined }}
        description="How each branch hands qualified leads to Sales Consultants and how many reach a booking. Click a branch, telecaller or consultant to narrow the view."
      />
      <SalesHandoffReport preset="ORGANIZATION" leadBasePath="/client-admin/leads" />
    </div>
  );
}
