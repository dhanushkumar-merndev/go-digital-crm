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
import { ApprovalRulesCard } from '@/features/administration/approval-rules-card';
import { TenantTargetConfigurationWorkspace } from '@/features/administration/tenant-target-configuration-workspace';
import { CompanyComplianceWorkspace } from '@/features/administration/company-compliance-workspace';
import { CompetitorCatalogWorkspace } from '@/features/administration/competitor-catalog-workspace';
import { SystemHealthWorkspace } from '@/features/administration/system-health-workspace';
import { TemplateWorkspace } from '@/features/administration/template-workspace';
import { NotificationWorkspace } from '@/features/notifications/notification-workspace';
import { CallWorkspace } from '@/features/calls/call-workspace';
import { AiCallFieldReviewWorkspace } from '@/features/calls/ai-call-field-review-workspace';
import { AutoCallResultWorkspace } from '@/features/auto-call/auto-call-result-workspace';
import { AutoIvrFlowBuilder } from '@/features/auto-call/auto-ivr-flow-builder';
import { InventoryPerformance } from '@/features/inventory/inventory-performance';
import { CustomerCarePerformance } from '@/features/customer-care/customer-care-performance';
import { CustomerCareWorkspace } from '@/features/customer-care/customer-care-workspace';
import { DeliveryFeedbackWorkspace } from '@/features/delivery/delivery-feedback-workspace';
import { MarketingWorkspace } from '@/features/marketing/marketing-workspace';
import { MarketingAutomationWorkspace } from '@/features/marketing/marketing-automation-workspace';
import { MarketingRulesWorkspace } from '@/features/marketing/marketing-rules-workspace';
import { AiImageCreationWorkspace } from '@/features/marketing/ai-image-creation-workspace';
import { BulkCampaignWorkspace } from '@/features/marketing/bulk-campaign-workspace';
import { AssetLibraryWorkspace } from '@/features/marketing/asset-library-workspace';
import { ReportExportWorkspace } from '@/features/reports/report-export-workspace';
import { AdminDashboard } from '@/features/administration/admin-dashboard';
import { ExecutiveDashboard } from '@/features/dashboards/executive-dashboard';
import { TenantDashboard } from '@/features/dashboards/tenant-dashboard';
import { ReviewApprovalWorkspace } from '@/features/customer-care/review-approval-workspace';
import { ReviewRequestsWorkspace } from '@/features/reviews/review-requests-workspace';
import {
  BusinessOperationsOverview,
  BusinessSalesOverview,
  BusinessShowroomPerformance,
} from '@/features/dashboards/business-overview-workspaces';
import { OwnerAiBusinessSummaryWorkspace } from '@/features/dashboards/owner-ai-business-summary';
import { SalesConsultantDashboard } from '@/features/dashboards/sales-consultant-dashboard';
import { TelecallerDashboard } from '@/features/dashboards/telecaller-dashboard';
import { SalesConsultantActivityTimeline } from '@/features/dashboards/sales-consultant-activity-timeline';
import { TeamManagerActivityTimeline } from '@/features/dashboards/team-manager-activity-timeline';
import { SalesConsultantPerformance } from '@/features/dashboards/sales-consultant-performance';
import {
  TeamManagerPerformance,
  TeamOverviewCard,
} from '@/features/dashboards/team-manager-performance';
import { SalesHandoffReport } from '@/features/dashboards/sales-handoff-report';
import { ClientAdminBranchPerformance } from '@/features/dashboards/client-admin-branch-performance';
import { TeamCallMonitor } from '@/features/dashboards/team-call-monitor';
import { ShowroomTargetWorkspace } from '@/features/dashboards/showroom-target-workspace';
import {
  ShowroomSalesTeamWorkspace,
  ShowroomTeamOverviewCard,
} from '@/features/dashboards/showroom-sales-team-workspace';
import { GmSalesAnalyticsWorkspace } from '@/features/dashboards/gm-sales-analytics-workspace';
import {
  GmShowroomTargetsCard,
  GmTargetWorkspace,
} from '@/features/dashboards/gm-target-workspace';
import { RoleWorkspace } from '@/features/administration/role-workspace';
import { UserWorkspace } from '@/features/administration/users/user-workspace';
import { IntegrationWorkspace } from '@/features/integrations/integration-workspace';
import { InventoryWorkspace } from '@/features/inventory/inventory-workspace';
import { AccessoriesWorkspace } from '@/features/inventory/accessories-workspace';
import { InboxWorkspace } from '@/features/inbox/inbox-workspace';
import { LeadAssignmentWorkspace } from '@/features/leads/lead-assignment-workspace';
import { DuplicateLeadDeletionWorkspace } from '@/features/leads/duplicate-lead-deletion-workspace';
import { LeadWorkspace } from '@/features/leads/lead-workspace';
import { OperationalCaseWorkspace } from '@/features/operations/operational-case-workspace';
import { OperationalCasePerformance } from '@/features/operations/operational-case-performance';
import { SalesExchangeWorkspace } from '@/features/operations/sales-exchange-workspace';
import { operationalCaseRoute } from '@/features/operations/operational-case-query';
import { PageHeader, PageShell } from '@/components/shared/page-header';
import { ProductionDataUnavailable } from '@/components/shared/production-data-unavailable';
import { isRoleKey } from '@/config/navigation';
import { legacyTabbedPageHref } from '@/config/navigation/legacy-redirects';
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
    slug.length === 3 &&
    slug[0] === 'calls' &&
    slug[2] === 'auto-call' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(slug[1]) &&
    !isLocalPreviewMode()
  )
    return <AutoCallResultWorkspace callId={slug[1]} role={role} />;
  if (
    role === 'client-admin' &&
    slug.length === 3 &&
    slug[0] === 'integrations' &&
    slug[1] === 'auto-ivr' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(slug[2]) &&
    !isLocalPreviewMode()
  )
    return <AutoIvrFlowBuilder flowId={slug[2]} />;
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
  // Targets & Performance merged into Showroom Performance; keep saved links working.
  if (role === 'business-owner' && slug[0] === 'targets-performance')
    redirect('/business-owner/showroom-performance');
  // Pages folded into tabs of one page on 2026-10-18; keep saved links working.
  const tabbedPageHref = legacyTabbedPageHref(role, slug[0]);
  if (tabbedPageHref) redirect(tabbedPageHref);
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
    return <DealershipWorkspace spec={spec} view="OWNERS" />;
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
    return <OwnerAiBusinessSummaryWorkspace spec={spec} view="SUMMARY" />;
  if (role === 'business-owner' && slug[0] === 'credits-usage' && !isLocalPreviewMode())
    return <OwnerAiBusinessSummaryWorkspace spec={spec} view="CREDITS" />;
  if (role === 'business-owner' && slug[0] === 'security-access' && !isLocalPreviewMode())
    return <SecurityWorkspace spec={spec} />;
  if (role === 'business-owner' && slug[0] === 'company-compliance' && !isLocalPreviewMode())
    return <CompanyComplianceWorkspace spec={spec} />;
  // Sales Manager and GM get Users only as a delegated permission; the RPC
  // enforces the delegation ceiling, so the page is the same admin workspace.
  if (
    ['client-admin', 'system-administrator', 'showroom-manager', 'gm-sales'].includes(role) &&
    slug[0] === 'users' &&
    !isLocalPreviewMode()
  )
    return <UserWorkspace spec={spec} mode="USER_ADMIN" />;
  if (
    (role === 'client-admin' || role === 'system-administrator') &&
    slug[0] === 'dashboard' &&
    !isLocalPreviewMode()
  )
    return <AdminDashboard spec={spec} role={role} />;
  if (role === 'client-admin' && slug[0] === 'branches' && !isLocalPreviewMode())
    return <BranchTeamWorkspace kind="branches" preset="MANAGE" role={role} spec={spec} />;
  if (role === 'client-admin' && slug[0] === 'teams' && !isLocalPreviewMode())
    return <BranchTeamWorkspace kind="teams" role={role} spec={spec} />;
  if (role === 'client-admin' && slug[0] === 'lead-assignment-settings' && !isLocalPreviewMode())
    return <BranchTeamWorkspace kind="teams" teamPreset="ASSIGNMENT" role={role} spec={spec} />;
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
    return (
      <div className="mx-auto w-full space-y-5">
        <TenantTargetConfigurationWorkspace spec={spec} />
        <ApprovalRulesCard />
      </div>
    );
  if (role === 'client-admin' && slug[0] === 'branch-performance' && !isLocalPreviewMode())
    return <ClientAdminBranchPerformance spec={spec} />;
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
    return <OwnerAiBusinessSummaryWorkspace spec={spec} />;
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
    return <ReportExportWorkspace spec={spec} preset="QUEUE" />;
  if (role === 'system-administrator' && slug[0] === 'system-health' && !isLocalPreviewMode())
    return <SystemHealthWorkspace spec={spec} />;
  if (
    (((role === 'inventory' || role === 'inventory-executive') &&
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
    (role === 'inventory' || role === 'inventory-executive') &&
    slug[0] === 'my-performance' &&
    !isLocalPreviewMode()
  )
    return <InventoryPerformance spec={spec} role={role} />;
  if (
    (role === 'inventory' || role === 'inventory-executive') &&
    slug[0] === 'accessories' &&
    !isLocalPreviewMode()
  )
    return <AccessoriesWorkspace spec={spec} />;
  // Reviews is its own queue: submitted feedback awaiting a Google review
  // invitation. It shared the generic case list before, which could never show a
  // promoter because only low ratings create a case.
  if (
    (role === 'customer-care' || role === 'customer-relationship-executive') &&
    slug[0] === 'reviews' &&
    !isLocalPreviewMode()
  )
    return <ReviewApprovalWorkspace spec={spec} />;
  if (
    (role === 'customer-care' || role === 'customer-relationship-executive') &&
    slug[0] === 'my-performance' &&
    !isLocalPreviewMode()
  )
    return <CustomerCarePerformance spec={spec} role={role} />;
  if (
    (role === 'customer-care' || role === 'customer-relationship-executive') &&
    ['dashboard', 'customer-cases', 'feedback', 'complaints-escalations'].includes(slug[0]) &&
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
  if (role === 'digital-marketing' && slug[0] === 'automations' && !isLocalPreviewMode())
    return <MarketingRulesWorkspace spec={spec} />;
  if (role === 'digital-marketing' && slug[0] === 'ai-content-image' && !isLocalPreviewMode())
    return <AiImageCreationWorkspace spec={spec} />;
  if (role === 'digital-marketing' && slug[0] === 'bulk-campaigns' && !isLocalPreviewMode())
    return <BulkCampaignWorkspace spec={spec} />;
  if (role === 'digital-marketing' && slug[0] === 'asset-library' && !isLocalPreviewMode())
    return <AssetLibraryWorkspace spec={spec} />;
  if (role === 'gm-sales' && slug[0] === 'lead-source-performance' && !isLocalPreviewMode())
    return <MarketingWorkspace spec={spec} slug={slug[0]} />;
  if (role === 'gm-sales' && slug[0] === 'targets' && !isLocalPreviewMode())
    return <GmTargetWorkspace spec={spec} />;
  // GM Sales holds booking.view, so this reads the same bookings the Business
  // Owner sees rather than a dashboard of its own.
  if (role === 'gm-sales' && slug[0] === 'bookings-overview' && !isLocalPreviewMode())
    return <SalesDocumentWorkspace kind="bookings" spec={spec} role={role} />;
  if (role === 'gm-sales' && slug[0] === 'sales-performance' && !isLocalPreviewMode())
    return <GmSalesAnalyticsWorkspace spec={spec} />;
  if (slug[0] === 'reports' && !isLocalPreviewMode())
    return (
      <ReportExportWorkspace
        spec={spec}
        preset={role === 'system-administrator' ? 'REQUEST' : 'FULL'}
      />
    );
  if (role === 'sales-consultant' && slug[0] === 'dashboard')
    return <SalesConsultantDashboard spec={spec} />;
  if (role === 'telecaller' && slug[0] === 'dashboard') return <TelecallerDashboard spec={spec} />;
  if (
    (role === 'sales-consultant' || role === 'telecaller') &&
    slug[0] === 'activity-timeline' &&
    !isLocalPreviewMode()
  )
    return <SalesConsultantActivityTimeline spec={spec} role={role} />;
  if (
    ['sales-consultant', 'business-owner', 'client-admin'].includes(role) &&
    slug[0] === 'competitor-compare' &&
    !isLocalPreviewMode()
  )
    return <CompetitorComparisonWorkspace spec={spec} />;
  // Review requests the person sent and what customers answered. The Customer
  // Care "Reviews" page is the approval queue for every submission instead.
  if (
    (role === 'sales-consultant' || role === 'telecaller') &&
    slug[0] === 'reviews' &&
    !isLocalPreviewMode()
  )
    return <ReviewRequestsWorkspace spec={spec} />;
  if ((role === 'sales-consultant' || role === 'telecaller') && slug[0] === 'performance')
    return <SalesConsultantPerformance spec={spec} role={role} />;
  if (role === 'team-manager' && slug[0] === 'team-performance' && !isLocalPreviewMode())
    return <TeamManagerPerformance spec={spec} showHandoffs />;
  // The dashboard is today's queue; Team Performance is the period analysis.
  // They used to be the same component, so both pages showed one screen.
  if (role === 'gm-sales' && slug[0] === 'dashboard' && !isLocalPreviewMode())
    return (
      <TenantDashboard spec={spec} role={role}>
        <GmShowroomTargetsCard />
      </TenantDashboard>
    );
  if (role === 'showroom-manager' && slug[0] === 'dashboard' && !isLocalPreviewMode())
    return (
      <TenantDashboard spec={spec} role={role}>
        <ShowroomTeamOverviewCard />
      </TenantDashboard>
    );
  if (role === 'team-manager' && slug[0] === 'dashboard' && !isLocalPreviewMode())
    return (
      <TenantDashboard spec={spec} role={role}>
        <TeamOverviewCard />
      </TenantDashboard>
    );
  if (role === 'team-manager' && slug[0] === 'lead-assignment' && !isLocalPreviewMode())
    return <LeadAssignmentWorkspace spec={spec} />;
  if (role === 'team-manager' && slug[0] === 'duplicate-leads' && !isLocalPreviewMode())
    return <DuplicateLeadDeletionWorkspace spec={spec} />;
  if (role === 'showroom-manager' && slug[0] === 'lead-assignment' && !isLocalPreviewMode())
    return <LeadAssignmentWorkspace spec={spec} audience="SHOWROOM_MANAGER" />;
  if (role === 'team-manager' && slug[0] === 'team-calls' && !isLocalPreviewMode())
    return <TeamCallMonitor spec={spec} />;
  if (role === 'team-manager' && slug[0] === 'team-activity' && !isLocalPreviewMode())
    return <TeamManagerActivityTimeline spec={spec} />;
  if (role === 'showroom-manager' && slug[0] === 'showroom-targets' && !isLocalPreviewMode())
    return <ShowroomTargetWorkspace spec={spec} />;
  if (role === 'showroom-manager' && slug[0] === 'sales-teams' && !isLocalPreviewMode())
    return <ShowroomSalesTeamWorkspace spec={spec} />;
  // Performance re-rendered the whole dashboard above its report; it now shows
  // only what the dashboard does not: conversion through the handoff stages.
  if (role === 'showroom-manager' && slug[0] === 'performance' && !isLocalPreviewMode())
    return (
      <PageShell>
        <PageHeader
          spec={spec}
          description="How your telecallers hand qualified leads to Sales Consultants, and how many reach a booking."
        />
        <SalesHandoffReport preset="SHOWROOM" leadBasePath="/showroom-manager/leads" />
      </PageShell>
    );
  if (
    (role === 'showroom-manager' || role === 'gm-sales') &&
    slug[0] === 'approvals' &&
    !isLocalPreviewMode()
  )
    return <ManagerApprovalsWorkspace spec={spec} />;
  if (
    ['team-manager', 'showroom-manager', 'gm-sales'].includes(role) &&
    slug[0] === 'escalations' &&
    !isLocalPreviewMode()
  )
    return <SalesEscalationWorkspace spec={spec} role={role} />;
  if (role === 'sales-consultant' && slug[0] === 'exchange' && !isLocalPreviewMode())
    return <SalesExchangeWorkspace spec={spec} role={role} />;
  if (role === 'business-owner' && slug[0] === 'dashboard' && !isLocalPreviewMode())
    return <ExecutiveDashboard spec={spec} />;
  if (role === 'business-owner' && slug[0] === 'sales-overview' && !isLocalPreviewMode())
    return <BusinessSalesOverview spec={spec} />;
  if (role === 'business-owner' && slug[0] === 'bookings-delivery' && !isLocalPreviewMode())
    return <SalesDocumentWorkspace kind="bookings" spec={spec} role={role} />;
  // These three were one shared TenantDashboard behind three navigation entries,
  // so every page rendered the same screen.
  if (role === 'business-owner' && slug[0] === 'showroom-performance' && !isLocalPreviewMode())
    return <BusinessShowroomPerformance spec={spec} />;
  if (role === 'business-owner' && slug[0] === 'operations-overview' && !isLocalPreviewMode())
    return <BusinessOperationsOverview spec={spec} />;
  if (
    (role === 'sales-consultant' || role === 'telecaller') &&
    slug[0] === 'messages' &&
    !isLocalPreviewMode()
  )
    return <InboxWorkspace role={role} />;
  if (role === 'delivery' && slug[0] === 'feedback' && !isLocalPreviewMode())
    return <DeliveryFeedbackWorkspace spec={spec} />;
  // A department dashboard summarises the queue; the case pages list it. The
  // dashboard was the case list itself, so the two pages were identical.
  if (slug[0] === 'dashboard' && operationalCaseRoute(role, slug[0]) && !isLocalPreviewMode())
    return <TenantDashboard spec={spec} role={role} />;
  if (slug[0] === 'my-performance' && operationalCaseRoute(role, slug[0]) && !isLocalPreviewMode())
    return <OperationalCasePerformance spec={spec} role={role} />;
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
