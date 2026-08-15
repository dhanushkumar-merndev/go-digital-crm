import { notFound } from 'next/navigation';
import { RecordWorkspace } from '@/components/domain/record-workspace';
import { ProductionDataUnavailable } from '@/components/shared/production-data-unavailable';
import { isRoleKey } from '@/config/navigation';
import { isLocalPreviewMode } from '@/lib/runtime/runtime-mode';

export default async function RecordPage({
  params,
}: {
  params: Promise<{ role: string; id: string }>;
}) {
  const { role, id } = await params;
  if (!isRoleKey(role)) notFound();
  if (!isLocalPreviewMode()) return <ProductionDataUnavailable />;
  return <RecordWorkspace role={role} id={id} />;
}
