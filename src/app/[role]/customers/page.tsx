import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { isRoleKey } from '@/config/navigation';
import { CustomerWorkspace } from '@/features/customers/customer-workspace';

export const metadata: Metadata = { title: 'Customers' };

export default async function CustomersPage({ params }: { params: Promise<{ role: string }> }) {
  const { role } = await params;
  if (!isRoleKey(role)) notFound();
  return <CustomerWorkspace role={role} />;
}
