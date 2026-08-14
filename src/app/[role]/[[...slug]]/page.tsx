import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { WorkspacePage } from '@/components/domain/workspace-page';
import { isRoleKey } from '@/config/navigation';
import { getPageSpec } from '@/config/page-specs';

type Props = { params: Promise<{ role: string; slug?: string[] }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { role, slug } = await params;
  if (!isRoleKey(role)) return {};
  const spec = getPageSpec(role, slug?.[0] ?? 'dashboard');
  return { title: spec?.title ?? 'Workspace' };
}

export default async function RolePage({ params }: Props) {
  const { role, slug } = await params;
  if (!isRoleKey(role)) notFound();
  if (!slug?.length) redirect(`/${role}/dashboard`);
  if (slug.length !== 1) notFound();
  const spec = getPageSpec(role, slug[0] ?? 'dashboard');
  if (!spec) notFound();
  return <WorkspacePage spec={spec} role={role} />;
}
