'use client';

import { usePathname } from 'next/navigation';
import { getRoleSkeleton } from '@/components/skeletons';
import { PageSkeleton } from '@/components/shared/page-skeleton';

export default function Loading() {
  const pathname = usePathname();
  if (!pathname) return <PageSkeleton />;

  const segments = pathname.split('/').filter(Boolean);
  const role = segments[0] || '';
  const slug = segments[1] || 'dashboard';

  if (slug === 'customers') {
    if (segments[2]) return getRoleSkeleton(role, 'customer-360');
    return getRoleSkeleton(role, 'customers');
  }
  if (slug === 'leads' && segments[2]) {
    return getRoleSkeleton(role, 'lead-detail');
  }
  if (slug === 'calls' && segments[3] === 'ai-review') {
    return getRoleSkeleton(role, 'ai-call-field-review');
  }
  if (slug === 'automation-rules' && segments[2]) {
    return getRoleSkeleton(role, 'automation-rule-detail');
  }
  if (slug === 'dealerships' && segments[2]) {
    return getRoleSkeleton(role, 'dealership-detail');
  }

  return getRoleSkeleton(role, slug);
}
