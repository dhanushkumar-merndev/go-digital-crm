'use client';

import type { RoleKey } from '@/config/navigation/types';
import type { PageSpec } from '@/lib/domain';
import { PersonalCasePerformance } from '@/features/operations/operational-case-performance';
import { fetchCustomerCarePerformance } from './customer-care-api';

/** My Performance for Customer Care and Customer Relationship executives. */
export function CustomerCarePerformance({ spec, role }: { spec: PageSpec; role: RoleKey }) {
  return (
    <PersonalCasePerformance
      spec={spec}
      cacheKey="CUSTOMER_CARE"
      casesHref={`/${role}/customer-cases`}
      fetchPerformance={fetchCustomerCarePerformance}
    />
  );
}
