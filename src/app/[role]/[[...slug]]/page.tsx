import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { WorkspacePage } from '@/components/domain/workspace-page';
import { BranchTeamWorkspace } from '@/features/administration/branch-team-workspace';
import { CallWorkspace } from '@/features/calls/call-workspace';
import { CustomerCareWorkspace } from '@/features/customer-care/customer-care-workspace';
import { MarketingWorkspace } from '@/features/marketing/marketing-workspace';
import { ReportExportWorkspace } from '@/features/reports/report-export-workspace';
import { TenantDashboard } from '@/features/dashboards/tenant-dashboard';
import { SalesConsultantDashboard } from '@/features/dashboards/sales-consultant-dashboard';
import { SalesConsultantPerformance } from '@/features/dashboards/sales-consultant-performance';
import { SalesConsultantActivityTimeline } from '@/features/dashboards/sales-consultant-activity-timeline';
import { RoleWorkspace } from '@/features/administration/role-workspace';
import { UserWorkspace } from '@/features/administration/users/user-workspace';
import { IntegrationWorkspace } from '@/features/integrations/integration-workspace';
import { InventoryWorkspace } from '@/features/inventory/inventory-workspace';
import { LeadWorkspace } from '@/features/leads/lead-workspace';
import { OperationalCaseWorkspace } from '@/features/operations/operational-case-workspace';
import { SalesExchangeWorkspace } from '@/features/operations/sales-exchange-workspace';
import { operationalCaseRoute } from '@/features/operations/operational-case-query';
import { ProductionDataUnavailable } from '@/components/shared/production-data-unavailable';
import { isRoleKey } from '@/config/navigation';
import { DealershipWorkspace } from '@/features/platform/dealership-workspace';
import { OnboardingReviewWorkspace } from '@/features/platform/onboarding-review-workspace';
import { PlatformDashboard } from '@/features/platform/platform-dashboard';
import { RetentionWorkspace } from '@/features/platform/retention/retention-workspace';
import { SupportSessionWorkspace } from '@/features/platform/support-session-workspace';
import { SalesDocumentWorkspace } from '@/features/sales/sales-document-workspace';
import { TaskWorkspace } from '@/features/tasks/task-workspace';
import { TestDriveWorkspace } from '@/features/test-drives/test-drive-workspace';
import { WorkWorkspace } from '@/features/work/workspace';
import { getPageSpec } from '@/config/page-specs';
import { isLocalPreviewMode } from '@/lib/runtime/runtime-mode';

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
  if (role === 'super-admin' && slug[0] === 'dashboard' && !isLocalPreviewMode())
    return <PlatformDashboard spec={spec} />;
  if (role === 'super-admin' && slug[0] === 'dealerships' && !isLocalPreviewMode())
    return <DealershipWorkspace spec={spec} />;
  if (role === 'super-admin' && slug[0] === 'onboarding-reviews' && !isLocalPreviewMode())
    return <OnboardingReviewWorkspace spec={spec} />;
  if (role === 'super-admin' && slug[0] === 'data-retention' && !isLocalPreviewMode())
    return <RetentionWorkspace spec={spec} />;
  if (role === 'super-admin' && slug[0] === 'support-sessions' && !isLocalPreviewMode())
    return <SupportSessionWorkspace spec={spec} role="super-admin" />;
  if (role === 'business-owner' && slug[0] === 'support-maintenance' && !isLocalPreviewMode())
    return <SupportSessionWorkspace spec={spec} role="business-owner" />;
  if (role === 'business-owner' && slug[0] === 'client-admins' && !isLocalPreviewMode())
    return <UserWorkspace spec={spec} mode="CLIENT_ADMIN_BOOTSTRAP" />;
  if (
    (role === 'client-admin' || role === 'system-administrator') &&
    slug[0] === 'users' &&
    !isLocalPreviewMode()
  )
    return <UserWorkspace spec={spec} mode="USER_ADMIN" />;
  if (role === 'client-admin' && slug[0] === 'branches' && !isLocalPreviewMode())
    return <BranchTeamWorkspace kind="branches" preset="MANAGE" role={role} spec={spec} />;
  if (role === 'client-admin' && slug[0] === 'teams' && !isLocalPreviewMode())
    return <BranchTeamWorkspace kind="teams" role={role} spec={spec} />;
  if (role === 'system-administrator' && slug[0] === 'branches-access' && !isLocalPreviewMode())
    return <BranchTeamWorkspace kind="branches" preset="ACCESS" role={role} spec={spec} />;
  if (
    (role === 'client-admin' || role === 'system-administrator') &&
    slug[0] === 'integrations' &&
    !isLocalPreviewMode()
  )
    return <IntegrationWorkspace spec={spec} role={role} />;
  if (
    (role === 'client-admin' || role === 'system-administrator') &&
    slug[0] === 'roles-permissions' &&
    !isLocalPreviewMode()
  )
    return <RoleWorkspace spec={spec} />;
  if (
    ((role === 'inventory' &&
      [
        'dashboard',
        'vehicle-inventory',
        'stock-allocation',
        'stock-ageing',
        'stock-transfer',
      ].includes(slug[0])) ||
      (role === 'sales-consultant' && slug[0] === 'stock-check')) &&
    !isLocalPreviewMode()
  )
    return <InventoryWorkspace key={`${role}:${slug[0]}`} spec={spec} role={role} slug={slug[0]} />;
  if (
    role === 'customer-care' &&
    ['dashboard', 'customer-cases', 'feedback', 'reviews', 'complaints-escalations'].includes(
      slug[0],
    ) &&
    !isLocalPreviewMode()
  )
    return <CustomerCareWorkspace spec={spec} role={role} slug={slug[0]} />;
  if (
    role === 'digital-marketing' &&
    ['dashboard', 'lead-sources', 'campaigns', 'social-posts', 'performance'].includes(slug[0]) &&
    !isLocalPreviewMode()
  )
    return <MarketingWorkspace spec={spec} slug={slug[0]} />;
  if (slug[0] === 'reports' && !isLocalPreviewMode()) return <ReportExportWorkspace spec={spec} />;
  if (role === 'sales-consultant' && slug[0] === 'dashboard')
    return <SalesConsultantDashboard spec={spec} />;
  if (role === 'sales-consultant' && slug[0] === 'performance')
    return <SalesConsultantPerformance />;
  if (operationalCaseRoute(role, slug[0]) && !isLocalPreviewMode())
    return <OperationalCaseWorkspace spec={spec} role={role} slug={slug[0]} />;
  if (slug[0] === 'dashboard' && !isLocalPreviewMode())
    return <TenantDashboard spec={spec} role={role} />;
  if (spec.category === 'leads' && !isLocalPreviewMode())
    return <LeadWorkspace spec={spec} slug={slug[0]} role={role} />;
  if (spec.category === 'calls' && !isLocalPreviewMode())
    return <CallWorkspace spec={spec} role={role} />;
  if (spec.category === 'followups' && !isLocalPreviewMode())
    return <WorkWorkspace kind="followups" spec={spec} role={role} />;
  if (spec.category === 'appointments' && !isLocalPreviewMode())
    return <WorkWorkspace kind="appointments" spec={spec} role={role} />;
  if (
    slug[0] === 'tasks' &&
    (role === 'telecaller' || role === 'sales-consultant') &&
    !isLocalPreviewMode()
  ) {
    if (role === 'sales-consultant') return <SalesConsultantActivityTimeline />;
    return <TaskWorkspace spec={spec} role={role} />;
  }
  if (
    spec.category === 'test-drives' &&
    (role === 'sales-consultant' || role === 'team-manager' || role === 'showroom-manager') &&
    !isLocalPreviewMode()
  )
    return <TestDriveWorkspace spec={spec} role={role} />;
  if (role === 'sales-consultant' && slug[0] === 'exchange' && !isLocalPreviewMode())
    return <SalesExchangeWorkspace />;
  if (spec.category === 'quotations' && !isLocalPreviewMode())
    return <SalesDocumentWorkspace kind="quotations" spec={spec} role={role} />;
  if (spec.category === 'bookings' && !isLocalPreviewMode())
    return <SalesDocumentWorkspace kind="bookings" spec={spec} role={role} />;
  if (!isLocalPreviewMode()) return <ProductionDataUnavailable />;
  return <WorkspacePage spec={spec} role={role} />;
}
