import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { WorkspacePage } from '@/components/domain/workspace-page';
import { BranchTeamWorkspace } from '@/features/administration/branch-team-workspace';
import { AuditLogWorkspace } from '@/features/administration/audit-log-workspace';
import { AutomationWorkspace } from '@/features/administration/automation-workspace';
import { AutomationRuleDetailWorkspace } from '@/features/administration/automation-rule-detail-workspace';
import { CustomFieldWorkspace } from '@/features/administration/custom-field-workspace';
import { MasterDataWorkspace } from '@/features/administration/master-data-workspace';
import { SecurityWorkspace } from '@/features/administration/security-workspace';
import { TenantModuleEntitlementsWorkspace } from '@/features/administration/tenant-module-entitlements-workspace';
import { TenantTargetConfigurationWorkspace } from '@/features/administration/tenant-target-configuration-workspace';
import { CompanyComplianceWorkspace } from '@/features/administration/company-compliance-workspace';
import { CompetitorCatalogWorkspace } from '@/features/administration/competitor-catalog-workspace';
import { SystemHealthWorkspace } from '@/features/administration/system-health-workspace';
import { TemplateWorkspace } from '@/features/administration/template-workspace';
import { NotificationWorkspace } from '@/features/notifications/notification-workspace';
import { CallWorkspace } from '@/features/calls/call-workspace';
import { AiCallFieldReviewWorkspace } from '@/features/calls/ai-call-field-review-workspace';
import { AiVoiceCallWorkspace } from '@/features/calls/ai-voice-call-workspace';
import { CustomerCareWorkspace } from '@/features/customer-care/customer-care-workspace';
import { DeliveryFeedbackWorkspace } from '@/features/delivery/delivery-feedback-workspace';
import { MarketingWorkspace } from '@/features/marketing/marketing-workspace';
import { MarketingAutomationWorkspace } from '@/features/marketing/marketing-automation-workspace';
import { AiImageCreationWorkspace } from '@/features/marketing/ai-image-creation-workspace';
import { ReportExportWorkspace } from '@/features/reports/report-export-workspace';
import { TenantDashboard } from '@/features/dashboards/tenant-dashboard';
import { OwnerAiBusinessSummaryWorkspace } from '@/features/dashboards/owner-ai-business-summary';
import { SalesConsultantDashboard } from '@/features/dashboards/sales-consultant-dashboard';
import { SalesConsultantActivityTimeline } from '@/features/dashboards/sales-consultant-activity-timeline';
import { SalesConsultantPerformance } from '@/features/dashboards/sales-consultant-performance';
import { TeamManagerPerformance } from '@/features/dashboards/team-manager-performance';
import { TeamCallMonitor } from '@/features/dashboards/team-call-monitor';
import { ShowroomTargetWorkspace } from '@/features/dashboards/showroom-target-workspace';
import { ShowroomSalesTeamWorkspace } from '@/features/dashboards/showroom-sales-team-workspace';
import { GmSalesAnalyticsWorkspace } from '@/features/dashboards/gm-sales-analytics-workspace';
import { GmTargetWorkspace } from '@/features/dashboards/gm-target-workspace';
import { RoleWorkspace } from '@/features/administration/role-workspace';
import { UserWorkspace } from '@/features/administration/users/user-workspace';
import { IntegrationWorkspace } from '@/features/integrations/integration-workspace';
import { InventoryWorkspace } from '@/features/inventory/inventory-workspace';
import { InboxWorkspace } from '@/features/inbox/inbox-workspace';
import { LeadAssignmentWorkspace } from '@/features/leads/lead-assignment-workspace';
import { LeadWorkspace } from '@/features/leads/lead-workspace';
import { OperationalCaseWorkspace } from '@/features/operations/operational-case-workspace';
import { SalesExchangeWorkspace } from '@/features/operations/sales-exchange-workspace';
import { operationalCaseRoute } from '@/features/operations/operational-case-query';
import { ProductionDataUnavailable } from '@/components/shared/production-data-unavailable';
import { isRoleKey } from '@/config/navigation';
import { DealershipWorkspace } from '@/features/platform/dealership-workspace';
import { DealershipDetailWorkspace } from '@/features/platform/dealership-detail-workspace';
import { OnboardingReviewWorkspace } from '@/features/platform/onboarding-review-workspace';
import { PlatformDashboard } from '@/features/platform/platform-dashboard';
import { ModuleWorkspace } from '@/features/platform/module-workspace';
import { PlatformIntegrationWorkspace } from '@/features/platform/platform-integration-workspace';
import { PlatformAiUsageWorkspace } from '@/features/platform/platform-ai-usage-workspace';
import { SubscriptionPlanWorkspace } from '@/features/platform/subscription-plan-workspace';
import { PlatformHealthWorkspace } from '@/features/platform/platform-health-workspace';
import { PlatformUserAccessWorkspace } from '@/features/platform/platform-user-access-workspace';
import { RetentionWorkspace } from '@/features/platform/retention/retention-workspace';
import { SupportSessionWorkspace } from '@/features/platform/support-session-workspace';
import { SalesDocumentWorkspace } from '@/features/sales/sales-document-workspace';
import { ManagerApprovalsWorkspace } from '@/features/sales/manager-approvals-workspace';
import { SalesEscalationWorkspace } from '@/features/sales/sales-escalation-workspace';
import { CompetitorComparisonWorkspace } from '@/features/sales/competitor-comparison-workspace';
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
  if (
    slug.length === 3 &&
    slug[0] === 'calls' &&
    slug[2] === 'ai-review' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(slug[1]) &&
    !isLocalPreviewMode()
  )
    return <AiCallFieldReviewWorkspace callId={slug[1]} role={role} />;
  if (
    role === 'system-administrator' &&
    slug.length === 2 &&
    slug[0] === 'automation-rules' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(slug[1]) &&
    !isLocalPreviewMode()
  )
    return <AutomationRuleDetailWorkspace ruleId={slug[1]} role={role} />;
  if (
    role === 'super-admin' &&
    slug.length === 2 &&
    slug[0] === 'dealerships' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(slug[1]) &&
    !isLocalPreviewMode()
  )
    return <DealershipDetailWorkspace organizationId={slug[1]} />;
  if (slug.length !== 1) notFound();
  const spec = getPageSpec(role, slug[0] ?? 'dashboard');
  if (!spec) notFound();
  if (role === 'super-admin' && slug[0] === 'dashboard' && !isLocalPreviewMode())
    return <PlatformDashboard spec={spec} />;
  if (role === 'super-admin' && slug[0] === 'modules-entitlements' && !isLocalPreviewMode())
    return <ModuleWorkspace spec={spec} />;
  if (role === 'super-admin' && slug[0] === 'integrations-providers' && !isLocalPreviewMode())
    return <PlatformIntegrationWorkspace spec={spec} />;
  if (role === 'super-admin' && slug[0] === 'credits-usage' && !isLocalPreviewMode())
    return <PlatformAiUsageWorkspace spec={spec} />;
  if (role === 'super-admin' && slug[0] === 'plans-features' && !isLocalPreviewMode())
    return <SubscriptionPlanWorkspace spec={spec} />;
  if (role === 'super-admin' && slug[0] === 'platform-health' && !isLocalPreviewMode())
    return <PlatformHealthWorkspace spec={spec} />;
  if (role === 'super-admin' && slug[0] === 'dealerships' && !isLocalPreviewMode())
    return <DealershipWorkspace spec={spec} />;
  if (role === 'super-admin' && slug[0] === 'business-owners' && !isLocalPreviewMode())
    return <DealershipWorkspace spec={spec} />;
  if (role === 'super-admin' && slug[0] === 'onboarding-reviews' && !isLocalPreviewMode())
    return <OnboardingReviewWorkspace spec={spec} />;
  if (role === 'super-admin' && slug[0] === 'data-retention' && !isLocalPreviewMode())
    return <RetentionWorkspace spec={spec} />;
  if (role === 'super-admin' && slug[0] === 'support-sessions' && !isLocalPreviewMode())
    return <SupportSessionWorkspace spec={spec} role="super-admin" />;
  if (role === 'super-admin' && slug[0] === 'security' && !isLocalPreviewMode())
    return <SecurityWorkspace spec={spec} />;
  if (role === 'super-admin' && slug[0] === 'audit-logs' && !isLocalPreviewMode())
    return <AuditLogWorkspace spec={spec} />;
  if (role === 'super-admin' && slug[0] === 'users-access' && !isLocalPreviewMode())
    return <PlatformUserAccessWorkspace spec={spec} />;
  if (role === 'business-owner' && slug[0] === 'support-maintenance' && !isLocalPreviewMode())
    return <SupportSessionWorkspace spec={spec} role="business-owner" />;
  if (role === 'business-owner' && slug[0] === 'client-admins' && !isLocalPreviewMode())
    return <UserWorkspace spec={spec} mode="CLIENT_ADMIN_BOOTSTRAP" />;
  if (role === 'business-owner' && slug[0] === 'ai-business-summary' && !isLocalPreviewMode())
    return <OwnerAiBusinessSummaryWorkspace />;
  if (role === 'business-owner' && slug[0] === 'credits-usage' && !isLocalPreviewMode())
    return <OwnerAiBusinessSummaryWorkspace audience="OWNER" heading="Credits & Usage" />;
  if (role === 'business-owner' && slug[0] === 'security-access' && !isLocalPreviewMode())
    return <SecurityWorkspace spec={spec} />;
  if (role === 'business-owner' && slug[0] === 'company-compliance' && !isLocalPreviewMode())
    return <CompanyComplianceWorkspace spec={spec} />;
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
  if (role === 'client-admin' && slug[0] === 'lead-assignment-settings' && !isLocalPreviewMode())
    return <BranchTeamWorkspace kind="teams" role={role} spec={spec} />;
  if (role === 'client-admin' && slug[0] === 'custom-fields' && !isLocalPreviewMode())
    return <CustomFieldWorkspace spec={spec} />;
  if (role === 'client-admin' && slug[0] === 'crm-configuration' && !isLocalPreviewMode())
    return <MasterDataWorkspace spec={spec} />;
  if (role === 'client-admin' && slug[0] === 'competitor-catalog' && !isLocalPreviewMode())
    return <CompetitorCatalogWorkspace spec={spec} />;
  if (role === 'client-admin' && slug[0] === 'modules-access' && !isLocalPreviewMode())
    return <TenantModuleEntitlementsWorkspace spec={spec} />;
  if (role === 'client-admin' && slug[0] === 'company-compliance' && !isLocalPreviewMode())
    return <CompanyComplianceWorkspace spec={spec} />;
  if (role === 'client-admin' && slug[0] === 'targets-approval-rules' && !isLocalPreviewMode())
    return <TenantTargetConfigurationWorkspace spec={spec} />;
  if (role === 'system-administrator' && slug[0] === 'branches-access' && !isLocalPreviewMode())
    return <BranchTeamWorkspace kind="branches" preset="ACCESS" role={role} spec={spec} />;
  if (role === 'system-administrator' && slug[0] === 'master-data' && !isLocalPreviewMode())
    return <MasterDataWorkspace spec={spec} />;
  if (
    (role === 'client-admin' || role === 'system-administrator') &&
    slug[0] === 'integrations' &&
    !isLocalPreviewMode()
  )
    return <IntegrationWorkspace spec={spec} role={role} />;
  if (role === 'client-admin' && slug[0] === 'ai-usage' && !isLocalPreviewMode())
    return <OwnerAiBusinessSummaryWorkspace audience="CLIENT_ADMIN" />;
  if (
    (role === 'client-admin' || role === 'system-administrator') &&
    slug[0] === 'roles-permissions' &&
    !isLocalPreviewMode()
  )
    return <RoleWorkspace spec={spec} />;
  if (
    (role === 'client-admin' || role === 'system-administrator') &&
    slug[0] === 'audit-logs' &&
    !isLocalPreviewMode()
  )
    return <AuditLogWorkspace spec={spec} />;
  if (
    role === 'system-administrator' &&
    slug[0] === 'alerts-notifications' &&
    !isLocalPreviewMode()
  )
    return <NotificationWorkspace spec={spec} />;
  if (role === 'system-administrator' && slug[0] === 'security' && !isLocalPreviewMode())
    return <SecurityWorkspace spec={spec} />;
  if (role === 'system-administrator' && slug[0] === 'automation-rules' && !isLocalPreviewMode())
    return <AutomationWorkspace spec={spec} />;
  if (role === 'system-administrator' && slug[0] === 'templates' && !isLocalPreviewMode())
    return <TemplateWorkspace spec={spec} />;
  if (role === 'system-administrator' && slug[0] === 'backup-data' && !isLocalPreviewMode())
    return <ReportExportWorkspace spec={spec} />;
  if (role === 'system-administrator' && slug[0] === 'system-health' && !isLocalPreviewMode())
    return <SystemHealthWorkspace spec={spec} />;
  if (
    ((role === 'inventory' &&
      [
        'dashboard',
        'vehicle-inventory',
        'stock-allocation',
        'stock-ageing',
        'stock-transfer',
      ].includes(slug[0])) ||
      (role === 'sales-consultant' && slug[0] === 'stock-check') ||
      (role === 'inventory' && slug[0] === 'my-performance')) &&
    !isLocalPreviewMode()
  )
    return <InventoryWorkspace key={`${role}:${slug[0]}`} spec={spec} role={role} slug={slug[0]} />;
  if (
    role === 'customer-care' &&
    [
      'dashboard',
      'customer-cases',
      'feedback',
      'reviews',
      'complaints-escalations',
      'my-performance',
    ].includes(slug[0]) &&
    !isLocalPreviewMode()
  )
    return <CustomerCareWorkspace spec={spec} role={role} slug={slug[0]} />;
  if (
    role === 'digital-marketing' &&
    ['dashboard', 'lead-sources', 'campaigns', 'social-posts', 'performance'].includes(slug[0]) &&
    !isLocalPreviewMode()
  )
    return <MarketingWorkspace spec={spec} slug={slug[0]} />;
  if (
    role === 'digital-marketing' &&
    ['drip-campaigns', 'reviews'].includes(slug[0]) &&
    !isLocalPreviewMode()
  )
    return (
      <MarketingAutomationWorkspace
        spec={spec}
        initialTab={slug[0] === 'reviews' ? 'REVIEWS' : 'DRIP'}
      />
    );
  if (role === 'digital-marketing' && slug[0] === 'ai-content-image' && !isLocalPreviewMode())
    return <AiImageCreationWorkspace spec={spec} />;
  if (role === 'gm-sales' && slug[0] === 'lead-source-performance' && !isLocalPreviewMode())
    return <MarketingWorkspace spec={spec} slug={slug[0]} />;
  if (role === 'gm-sales' && slug[0] === 'targets' && !isLocalPreviewMode())
    return <GmTargetWorkspace />;
  if (
    role === 'gm-sales' &&
    [
      'sales-performance',
      'showroom-comparison',
      'consultant-ranking',
      'model-performance',
    ].includes(slug[0]) &&
    !isLocalPreviewMode()
  )
    return (
      <GmSalesAnalyticsWorkspace
        view={slug[0] as Parameters<typeof GmSalesAnalyticsWorkspace>[0]['view']}
      />
    );
  if (slug[0] === 'reports' && !isLocalPreviewMode()) return <ReportExportWorkspace spec={spec} />;
  if (role === 'sales-consultant' && slug[0] === 'dashboard')
    return <SalesConsultantDashboard spec={spec} />;
  if (
    (role === 'sales-consultant' || role === 'telecaller') &&
    slug[0] === 'activity-timeline' &&
    !isLocalPreviewMode()
  )
    return <SalesConsultantActivityTimeline role={role} />;
  if (role === 'sales-consultant' && slug[0] === 'ai-voice-calls' && !isLocalPreviewMode())
    return <AiVoiceCallWorkspace />;
  if (role === 'sales-consultant' && slug[0] === 'competitor-compare' && !isLocalPreviewMode())
    return <CompetitorComparisonWorkspace spec={spec} />;
  if ((role === 'sales-consultant' || role === 'telecaller') && slug[0] === 'performance')
    return <SalesConsultantPerformance role={role} />;
  if (role === 'team-manager' && slug[0] === 'team-performance' && !isLocalPreviewMode())
    return <TeamManagerPerformance />;
  if (role === 'team-manager' && slug[0] === 'dashboard' && !isLocalPreviewMode())
    return <TeamManagerPerformance heading="Team Manager Workspace" />;
  if (role === 'team-manager' && slug[0] === 'lead-assignment' && !isLocalPreviewMode())
    return <LeadAssignmentWorkspace />;
  if (role === 'showroom-manager' && slug[0] === 'lead-assignment' && !isLocalPreviewMode())
    return <LeadAssignmentWorkspace audience="SHOWROOM_MANAGER" />;
  if (role === 'team-manager' && slug[0] === 'team-calls' && !isLocalPreviewMode())
    return <TeamCallMonitor />;
  if (role === 'showroom-manager' && slug[0] === 'showroom-targets' && !isLocalPreviewMode())
    return <ShowroomTargetWorkspace />;
  if (role === 'showroom-manager' && slug[0] === 'sales-teams' && !isLocalPreviewMode())
    return <ShowroomSalesTeamWorkspace />;
  if (role === 'showroom-manager' && slug[0] === 'performance' && !isLocalPreviewMode())
    return <TenantDashboard spec={spec} role={role} heading="Showroom Performance" />;
  if (
    (role === 'showroom-manager' || role === 'gm-sales') &&
    slug[0] === 'approvals' &&
    !isLocalPreviewMode()
  )
    return <ManagerApprovalsWorkspace />;
  if (
    ['team-manager', 'showroom-manager', 'gm-sales'].includes(role) &&
    slug[0] === 'escalations' &&
    !isLocalPreviewMode()
  )
    return <SalesEscalationWorkspace role={role} />;
  if (role === 'sales-consultant' && slug[0] === 'exchange' && !isLocalPreviewMode())
    return <SalesExchangeWorkspace role={role} />;
  if (role === 'business-owner' && slug[0] === 'sales-overview' && !isLocalPreviewMode())
    return <TenantDashboard spec={spec} role={role} heading="Sales Overview" />;
  if (role === 'business-owner' && slug[0] === 'targets-performance' && !isLocalPreviewMode())
    return <TenantTargetConfigurationWorkspace spec={spec} readOnly />;
  if (role === 'business-owner' && slug[0] === 'bookings-delivery' && !isLocalPreviewMode())
    return <SalesDocumentWorkspace kind="bookings" spec={spec} role={role} />;
  if (
    role === 'business-owner' &&
    ['showroom-performance', 'operations-overview'].includes(slug[0]) &&
    !isLocalPreviewMode()
  )
    return <TenantDashboard spec={spec} role={role} />;
  if (
    (role === 'sales-consultant' || role === 'telecaller') &&
    slug[0] === 'messages' &&
    !isLocalPreviewMode()
  )
    return <InboxWorkspace role={role} />;
  if (role === 'delivery' && slug[0] === 'feedback' && !isLocalPreviewMode())
    return <DeliveryFeedbackWorkspace spec={spec} />;
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
    return <TaskWorkspace spec={spec} role={role} />;
  }
  if (
    spec.category === 'test-drives' &&
    (role === 'sales-consultant' || role === 'team-manager' || role === 'showroom-manager') &&
    !isLocalPreviewMode()
  )
    return <TestDriveWorkspace spec={spec} role={role} />;
  if (spec.category === 'quotations' && !isLocalPreviewMode())
    return <SalesDocumentWorkspace kind="quotations" spec={spec} role={role} />;
  if (spec.category === 'bookings' && !isLocalPreviewMode())
    return <SalesDocumentWorkspace kind="bookings" spec={spec} role={role} />;
  if (!isLocalPreviewMode()) return <ProductionDataUnavailable />;
  return <WorkspacePage spec={spec} role={role} />;
}
