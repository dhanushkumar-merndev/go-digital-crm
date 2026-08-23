'use client';

import { usePathname } from 'next/navigation';
import { getSalesConsultantSkeleton } from '@/components/skeletons/sales-consultant-skeletons';
import { PageSkeleton } from '@/components/shared/page-skeleton';

export default function RoleLoading() {
  const pathname = usePathname();
  if (!pathname) return <PageSkeleton />;

  const segments = pathname.split('/').filter(Boolean);
  const role = segments[0];
  const slug = segments[1] || 'dashboard';

  if (role === 'sales-consultant' || role === 'telecaller') {
    return getSalesConsultantSkeleton(slug);
  }

  return <PageSkeleton />;
}
