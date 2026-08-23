import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { isRoleKey } from '@/config/navigation';
import { LeadDetailWorkspace } from '@/features/leads/lead-detail-workspace';
import { isLeadUuid } from '@/features/leads/lead-detail-api';

export const metadata: Metadata = { title: 'Lead details' };

export default async function LeadDetailPage({
  params,
}: {
  params: Promise<{ role: string; id: string }>;
}) {
  const { role, id } = await params;
  if (!isRoleKey(role) || !isLeadUuid(id)) notFound();
  return <LeadDetailWorkspace role={role} leadId={id} />;
}
