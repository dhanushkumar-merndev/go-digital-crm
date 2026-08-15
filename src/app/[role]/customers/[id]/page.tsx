import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { isRoleKey } from '@/config/navigation';
import { Customer360Workspace } from '@/features/customers/customer-360-workspace';
import { isCustomerUuid } from '@/features/customers/customer-workspace-query';

export const metadata: Metadata = { title: 'Customer 360' };

export default async function Customer360Page({
  params,
}: {
  params: Promise<{ role: string; id: string }>;
}) {
  const { role, id } = await params;
  if (!isRoleKey(role) || !isCustomerUuid(id)) notFound();
  return <Customer360Workspace role={role} customerId={id} />;
}
