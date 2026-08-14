import { notFound } from 'next/navigation';
import { RecordWorkspace } from '@/components/domain/record-workspace';
import { isRoleKey } from '@/config/navigation';

export default async function RecordPage({
  params,
}: {
  params: Promise<{ role: string; id: string }>;
}) {
  const { role, id } = await params;
  if (!isRoleKey(role)) notFound();
  return <RecordWorkspace role={role} id={id} />;
}
