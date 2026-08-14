import { notFound } from 'next/navigation';
import { CrmShell } from '@/components/shared/crm-shell';
import { isRoleKey } from '@/config/navigation';

export default async function RoleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ role: string }>;
}) {
  const { role } = await params;
  if (!isRoleKey(role)) notFound();
  return <CrmShell role={role}>{children}</CrmShell>;
}
