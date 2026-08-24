'use client';

import {
  SalesConsultantDashboardSkeleton,
  LeadWorkspaceSkeleton,
  FollowupsSkeleton,
  TasksSkeleton,
  CallsSkeleton,
  AiVoiceCallsSkeleton,
  InboxSkeleton,
  AppointmentsSkeleton,
  TestDrivesSkeleton,
  CompetitorCompareSkeleton,
  QuotationsSkeleton,
  StockCheckSkeleton,
  SalesExchangeSkeleton,
  BookingsSkeleton,
  SalesConsultantPerformanceSkeleton,
  SalesConsultantTimelineSkeleton,
} from './sales-consultant-skeletons';

import {
  TeamManagerPerformanceSkeleton,
  TeamCallMonitorSkeleton,
  ShowroomSalesTeamSkeleton,
  ShowroomTargetSkeleton,
  GmSalesAnalyticsSkeleton,
  GmTargetSkeleton,
  LeadAssignmentSkeleton,
  ManagerApprovalsSkeleton,
  SalesEscalationSkeleton,
} from './management-skeletons';

import {
  AdminUsersSkeleton,
  BranchTeamSkeleton,
  RolesPermissionsSkeleton,
  CustomFieldsSkeleton,
  MasterDataSkeleton,
  CompetitorCatalogSkeleton,
  TenantModuleEntitlementsSkeleton,
  TenantTargetConfigurationSkeleton,
  CompanyComplianceSkeleton,
  SystemHealthSkeleton,
  AutomationWorkspaceSkeleton,
  AutomationRuleDetailSkeleton,
  TemplateWorkspaceSkeleton,
  SecurityWorkspaceSkeleton,
  AuditLogWorkspaceSkeleton,
  OwnerAiBusinessSummarySkeleton,
  IntegrationWorkspaceSkeleton,
  NotificationWorkspaceSkeleton,
  ReportExportWorkspaceSkeleton,
} from './admin-skeletons';

import {
  PlatformDashboardSkeleton,
  DealershipWorkspaceSkeleton,
  DealershipDetailSkeleton,
  OnboardingReviewSkeleton,
  SubscriptionPlanSkeleton,
  ModuleWorkspaceSkeleton,
  PlatformIntegrationSkeleton,
  PlatformAiUsageSkeleton,
  PlatformHealthSkeleton,
  PlatformUserAccessSkeleton,
  RetentionWorkspaceSkeleton,
  SupportSessionSkeleton,
} from './platform-skeletons';

import {
  OperationalCaseWorkspaceSkeleton,
  InventoryWorkspaceSkeleton,
  DeliveryFeedbackSkeleton,
  CustomerCareWorkspaceSkeleton,
  CustomerRelationshipDashboardSkeleton,
  MarketingWorkspaceSkeleton,
  MarketingAutomationSkeleton,
  AiImageCreationSkeleton,
} from './operations-skeletons';

import { TenantDashboardSkeleton } from './dashboard-skeletons';
import { PageSkeleton } from '@/components/shared/page-skeleton';

// Re-export all individual skeleton components
export * from './sales-consultant-skeletons';
export * from './management-skeletons';
export * from './admin-skeletons';
export * from './platform-skeletons';
export * from './operations-skeletons';
export * from './dashboard-skeletons';

// ==========================================
// UNIVERSAL ROUTE & ROLE AWARE DISPATCHER
// ==========================================
export function getRoleSkeleton(role: string, slug: string = 'dashboard') {
  // 1. Sales Consultant & Telecaller
  if (role === 'sales-consultant' || role === 'telecaller') {
    switch (slug) {
      case 'dashboard':
        return role === 'sales-consultant' ? (
          <SalesConsultantDashboardSkeleton />
        ) : (
          <TenantDashboardSkeleton role="telecaller" />
        );
      case 'new-leads':
      case 'my-leads':
        return <LeadWorkspaceSkeleton />;
      case 'follow-ups':
        return <FollowupsSkeleton />;
      case 'tasks':
        return <TasksSkeleton />;
      case 'calls':
        return <CallsSkeleton />;
      case 'ai-voice-calls':
        return <AiVoiceCallsSkeleton />;
      case 'messages':
      case 'inbox':
        return <InboxSkeleton />;
      case 'appointments':
        return <AppointmentsSkeleton />;
      case 'test-drives':
        return <TestDrivesSkeleton />;
      case 'competitor-compare':
        return <CompetitorCompareSkeleton />;
      case 'quotations':
        return <QuotationsSkeleton />;
      case 'stock-check':
        return <StockCheckSkeleton />;
      case 'exchange':
        return <SalesExchangeSkeleton />;
      case 'bookings':
        return <BookingsSkeleton />;
      case 'performance':
        return <SalesConsultantPerformanceSkeleton />;
      case 'activity-timeline':
        return <SalesConsultantTimelineSkeleton />;
      default:
        return <CallsSkeleton />;
    }
  }

  // 2. Team Manager
  if (role === 'team-manager') {
    switch (slug) {
      case 'dashboard':
      case 'team-performance':
        return <TeamManagerPerformanceSkeleton />;
      case 'team-leads':
      case 'lost-leads':
        return <LeadWorkspaceSkeleton />;
      case 'lead-assignment':
        return <LeadAssignmentSkeleton />;
      case 'follow-ups':
        return <FollowupsSkeleton />;
      case 'team-calls':
        return <TeamCallMonitorSkeleton />;
      case 'appointments':
        return <AppointmentsSkeleton />;
      case 'test-drives':
        return <TestDrivesSkeleton />;
      case 'quotations':
        return <QuotationsSkeleton />;
      case 'bookings':
        return <BookingsSkeleton />;
      case 'escalations':
        return <SalesEscalationSkeleton />;
      case 'reports':
        return <ReportExportWorkspaceSkeleton />;
      default:
        return <TeamManagerPerformanceSkeleton />;
    }
  }

  // 3. Showroom Manager
  if (role === 'showroom-manager') {
    switch (slug) {
      case 'dashboard':
      case 'performance':
        return <TenantDashboardSkeleton role="showroom-manager" />;
      case 'showroom-leads':
      case 'lost-leads':
        return <LeadWorkspaceSkeleton />;
      case 'lead-assignment':
        return <LeadAssignmentSkeleton />;
      case 'follow-ups':
        return <FollowupsSkeleton />;
      case 'team-calls':
        return <TeamCallMonitorSkeleton />;
      case 'appointments':
        return <AppointmentsSkeleton />;
      case 'test-drives':
        return <TestDrivesSkeleton />;
      case 'quotations':
        return <QuotationsSkeleton />;
      case 'bookings':
        return <BookingsSkeleton />;
      case 'approvals':
        return <ManagerApprovalsSkeleton />;
      case 'sales-teams':
        return <ShowroomSalesTeamSkeleton />;
      case 'showroom-targets':
        return <ShowroomTargetSkeleton />;
      case 'escalations':
        return <SalesEscalationSkeleton />;
      case 'reports':
        return <ReportExportWorkspaceSkeleton />;
      case 'users':
        return <AdminUsersSkeleton />;
      default:
        return <TenantDashboardSkeleton role="showroom-manager" />;
    }
  }

  // 4. GM Sales Executive
  if (role === 'gm-sales') {
    switch (slug) {
      case 'dashboard':
        return <TenantDashboardSkeleton role="gm-sales" />;
      case 'sales-leads':
      case 'lost-leads':
        return <LeadWorkspaceSkeleton />;
      case 'showroom-comparison':
      case 'sales-performance':
      case 'consultant-ranking':
      case 'model-performance':
        return <GmSalesAnalyticsSkeleton />;
      case 'lead-source-performance':
        return <MarketingWorkspaceSkeleton />;
      case 'targets':
        return <GmTargetSkeleton />;
      case 'approvals':
        return <ManagerApprovalsSkeleton />;
      case 'bookings-overview':
        return <BookingsSkeleton />;
      case 'escalations':
        return <SalesEscalationSkeleton />;
      case 'reports':
        return <ReportExportWorkspaceSkeleton />;
      case 'users':
        return <AdminUsersSkeleton />;
      default:
        return <TenantDashboardSkeleton role="gm-sales" />;
    }
  }

  // 5. Client Admin
  if (role === 'client-admin') {
    switch (slug) {
      case 'dashboard':
        return <TenantDashboardSkeleton role="client-admin" />;
      case 'branches':
      case 'teams':
      case 'lead-assignment-settings':
        return <BranchTeamSkeleton />;
      case 'users':
        return <AdminUsersSkeleton />;
      case 'roles-permissions':
        return <RolesPermissionsSkeleton />;
      case 'custom-fields':
        return <CustomFieldsSkeleton />;
      case 'crm-configuration':
        return <MasterDataSkeleton />;
      case 'competitor-catalog':
        return <CompetitorCatalogSkeleton />;
      case 'integrations':
        return <IntegrationWorkspaceSkeleton />;
      case 'modules-access':
        return <TenantModuleEntitlementsSkeleton />;
      case 'targets-approval-rules':
        return <TenantTargetConfigurationSkeleton />;
      case 'ai-usage':
        return <OwnerAiBusinessSummarySkeleton />;
      case 'company-compliance':
        return <CompanyComplianceSkeleton />;
      case 'audit-logs':
        return <AuditLogWorkspaceSkeleton />;
      case 'reports':
        return <ReportExportWorkspaceSkeleton />;
      default:
        return <TenantDashboardSkeleton role="client-admin" />;
    }
  }

  // 6. System Administrator
  if (role === 'system-administrator') {
    switch (slug) {
      case 'dashboard':
        return <TenantDashboardSkeleton role="system-administrator" />;
      case 'users':
        return <AdminUsersSkeleton />;
      case 'roles-permissions':
        return <RolesPermissionsSkeleton />;
      case 'branches-access':
        return <BranchTeamSkeleton />;
      case 'master-data':
        return <MasterDataSkeleton />;
      case 'integrations':
        return <IntegrationWorkspaceSkeleton />;
      case 'automation-rules':
        return <AutomationWorkspaceSkeleton />;
      case 'automation-rule-detail':
        return <AutomationRuleDetailSkeleton />;
      case 'templates':
        return <TemplateWorkspaceSkeleton />;
      case 'alerts-notifications':
        return <NotificationWorkspaceSkeleton />;
      case 'system-health':
        return <SystemHealthSkeleton />;
      case 'audit-logs':
        return <AuditLogWorkspaceSkeleton />;
      case 'backup-data':
      case 'reports':
        return <ReportExportWorkspaceSkeleton />;
      case 'security':
        return <SecurityWorkspaceSkeleton />;
      default:
        return <TenantDashboardSkeleton role="system-administrator" />;
    }
  }

  // 7. Business Owner
  if (role === 'business-owner') {
    switch (slug) {
      case 'dashboard':
      case 'sales-overview':
      case 'showroom-performance':
      case 'operations-overview':
        return <TenantDashboardSkeleton role="business-owner" />;
      case 'bookings-delivery':
        return <BookingsSkeleton />;
      case 'targets-performance':
        return <TenantTargetConfigurationSkeleton />;
      case 'ai-business-summary':
      case 'credits-usage':
        return <OwnerAiBusinessSummarySkeleton />;
      case 'reports':
        return <ReportExportWorkspaceSkeleton />;
      case 'client-admins':
        return <AdminUsersSkeleton />;
      case 'company-compliance':
        return <CompanyComplianceSkeleton />;
      case 'support-maintenance':
        return <SupportSessionSkeleton />;
      case 'security-access':
        return <SecurityWorkspaceSkeleton />;
      default:
        return <TenantDashboardSkeleton role="business-owner" />;
    }
  }

  // 8. Super Admin
  if (role === 'super-admin') {
    switch (slug) {
      case 'dashboard':
        return <PlatformDashboardSkeleton />;
      case 'dealerships':
      case 'business-owners':
        return <DealershipWorkspaceSkeleton />;
      case 'dealership-detail':
        return <DealershipDetailSkeleton />;
      case 'onboarding-reviews':
        return <OnboardingReviewSkeleton />;
      case 'plans-features':
        return <SubscriptionPlanSkeleton />;
      case 'modules-entitlements':
        return <ModuleWorkspaceSkeleton />;
      case 'credits-usage':
        return <PlatformAiUsageSkeleton />;
      case 'integrations-providers':
        return <PlatformIntegrationSkeleton />;
      case 'support-sessions':
        return <SupportSessionSkeleton />;
      case 'platform-health':
        return <PlatformHealthSkeleton />;
      case 'users-access':
        return <PlatformUserAccessSkeleton />;
      case 'security':
        return <SecurityWorkspaceSkeleton />;
      case 'audit-logs':
        return <AuditLogWorkspaceSkeleton />;
      case 'data-retention':
        return <RetentionWorkspaceSkeleton />;
      case 'platform-settings':
        return <MasterDataSkeleton />;
      case 'reports':
        return <ReportExportWorkspaceSkeleton />;
      default:
        return <PlatformDashboardSkeleton />;
    }
  }

  // 9. Inventory Manager
  if (role === 'inventory') {
    switch (slug) {
      case 'dashboard':
        return <TenantDashboardSkeleton role="inventory" />;
      case 'vehicle-inventory':
      case 'stock-allocation':
      case 'stock-ageing':
      case 'stock-transfer':
      case 'my-performance':
        return <InventoryWorkspaceSkeleton />;
      case 'reports':
        return <ReportExportWorkspaceSkeleton />;
      default:
        return <TenantDashboardSkeleton role="inventory" />;
    }
  }

  // 10. Finance Manager
  if (role === 'finance') {
    switch (slug) {
      case 'dashboard':
        return <TenantDashboardSkeleton role="finance" />;
      case 'finance-cases':
      case 'pending-documents':
      case 'applications':
      case 'disbursement':
      case 'my-performance':
        return <OperationalCaseWorkspaceSkeleton />;
      case 'reports':
        return <ReportExportWorkspaceSkeleton />;
      default:
        return <TenantDashboardSkeleton role="finance" />;
    }
  }

  // 11. Insurance Manager
  if (role === 'insurance') {
    switch (slug) {
      case 'dashboard':
        return <TenantDashboardSkeleton role="insurance" />;
      case 'insurance-cases':
      case 'my-performance':
        return <OperationalCaseWorkspaceSkeleton />;
      case 'reports':
        return <ReportExportWorkspaceSkeleton />;
      default:
        return <TenantDashboardSkeleton role="insurance" />;
    }
  }

  // 12. RTO Manager
  if (role === 'rto') {
    switch (slug) {
      case 'dashboard':
        return <TenantDashboardSkeleton role="rto" />;
      case 'rto-cases':
      case 'my-performance':
        return <OperationalCaseWorkspaceSkeleton />;
      case 'reports':
        return <ReportExportWorkspaceSkeleton />;
      default:
        return <TenantDashboardSkeleton role="rto" />;
    }
  }

  // 13. Used Car / Exchange Manager
  if (role === 'exchange') {
    switch (slug) {
      case 'dashboard':
        return <TenantDashboardSkeleton role="exchange" />;
      case 'exchange-requests':
      case 'evaluations':
      case 'accepted-exchanges':
      case 'my-performance':
        return <OperationalCaseWorkspaceSkeleton />;
      case 'reports':
        return <ReportExportWorkspaceSkeleton />;
      default:
        return <TenantDashboardSkeleton role="exchange" />;
    }
  }

  // 14. Delivery Manager
  if (role === 'delivery') {
    switch (slug) {
      case 'dashboard':
        return <TenantDashboardSkeleton role="delivery" />;
      case 'upcoming-deliveries':
      case 'delivery-planner':
      case 'pending-checklist':
      case 'ready-for-delivery':
      case 'delivered':
      case 'delivery-photos':
      case 'my-performance':
        return <OperationalCaseWorkspaceSkeleton />;
      case 'feedback':
        return <DeliveryFeedbackSkeleton />;
      case 'reports':
        return <ReportExportWorkspaceSkeleton />;
      default:
        return <TenantDashboardSkeleton role="delivery" />;
    }
  }

  // 15. Customer Relationship Manager
  if (role === 'customer-care') {
    switch (slug) {
      case 'dashboard':
        return <CustomerRelationshipDashboardSkeleton />;
      case 'customer-cases':
      case 'feedback':
      case 'reviews':
      case 'complaints-escalations':
      case 'my-performance':
        return <CustomerCareWorkspaceSkeleton />;
      case 'follow-ups':
        return <FollowupsSkeleton />;
      case 'reports':
        return <ReportExportWorkspaceSkeleton />;
      default:
        return <CustomerRelationshipDashboardSkeleton />;
    }
  }

  // 16. Digital Marketing Manager
  if (role === 'digital-marketing') {
    switch (slug) {
      case 'dashboard':
      case 'lead-sources':
      case 'campaigns':
      case 'social-posts':
      case 'performance':
        return <MarketingWorkspaceSkeleton />;
      case 'drip-campaigns':
      case 'reviews':
        return <MarketingAutomationSkeleton />;
      case 'ai-content-image':
        return <AiImageCreationSkeleton />;
      case 'reports':
        return <ReportExportWorkspaceSkeleton />;
      default:
        return <MarketingWorkspaceSkeleton />;
    }
  }

  // Fallback
  return <PageSkeleton />;
}
