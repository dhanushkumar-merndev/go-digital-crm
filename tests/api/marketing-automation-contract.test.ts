import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202608220035_marketing_automation_workspace.sql');
const api = source('src/features/marketing/marketing-automation-api.ts');
const workspace = source('src/features/marketing/marketing-automation-workspace.tsx');
const route = source('src/app/[role]/[[...slug]]/page.tsx');

describe('marketing automation contract', () => {
  it('keeps drip campaigns and review requests tenant-scoped, permissioned and private', () => {
    expect(migration).toContain("('marketing.automation.view', 'marketing'");
    expect(migration).toContain("('marketing.automation.manage', 'marketing'");
    expect(migration).toContain('create table public.marketing_drip_campaigns');
    expect(migration).toContain('create table public.marketing_drip_steps');
    expect(migration).toContain('create table public.customer_review_requests');
    expect(migration).toContain(
      'app_private.can_access_branch(current_organization_id, target_branch_id)',
    );
    expect(migration).toContain(
      'app_private.can_access_customer(current_organization_id, target_customer_id)',
    );
    expect(migration).toContain('enable row level security');
    expect(migration).toContain('revoke insert, update, delete, truncate');
  });

  it('uses idempotent, audited RPCs instead of browser table writes', () => {
    expect(migration).toContain(
      'create or replace function public.create_marketing_drip_campaign(',
    );
    expect(migration).toContain(
      'create or replace function public.create_marketing_review_request(',
    );
    expect(migration).toContain('app_private.replay_marketing_automation_request');
    expect(migration).toContain("'marketing_automation.drip_created'");
    expect(migration).toContain("'marketing_automation.review_created'");
    expect(migration).toContain("'QUEUED'");
    expect(api).toContain("rpc('create_marketing_drip_campaign'");
    expect(api).toContain("rpc('create_marketing_review_request'");
  });

  it('provides working campaign and review flows with scoped customer selection', () => {
    expect(api).toContain("rpc('get_marketing_automation_workspace'");
    expect(api).toContain("rpc('get_marketing_review_customer_options'");
    expect(workspace).toContain('Create drip campaign');
    expect(workspace).toContain('Request a Google review');
    expect(workspace).toContain('Queue request');
    expect(workspace).toContain('useTenantRealtimeInvalidation');
    expect(route).toContain("['drip-campaigns', 'reviews'].includes(slug[0])");
    expect(route).toContain('<MarketingAutomationWorkspace');
  });
});
