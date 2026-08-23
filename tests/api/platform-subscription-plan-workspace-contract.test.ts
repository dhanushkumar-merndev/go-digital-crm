import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202608220018_platform_subscription_plan_workspace.sql');
const api = source('src/features/platform/subscription-plan-workspace-api.ts');
const workspace = source('src/features/platform/subscription-plan-workspace.tsx');
const route = source('src/app/[role]/[[...slug]]/page.tsx');

describe('platform subscription plan workspace backend contract', () => {
  it('requires Super Admin MFA and returns the real plan-module matrix', () => {
    expect(migration).toContain('create or replace function public.get_platform_subscription_plan_workspace()');
    expect(migration).toContain('app_private.is_platform_admin()');
    expect(migration).toContain('app_private.mfa_policy_satisfied(null)');
    expect(migration).toContain("'available_modules'");
    expect(migration).toContain("'plans'");
    expect(migration).toContain("'modules'");
  });

  it('saves create/edit/activation changes through an audited, idempotent mutation', () => {
    expect(migration).toContain('create or replace function public.save_platform_subscription_plan(');
    expect(migration).toContain('platform_subscription_plan_save_request_unique_idx');
    expect(migration).toContain("'platform_subscription_plan.saved'");
    expect(migration).toContain('delete from public.plan_modules where plan_id = saved_plan.id');
    expect(migration).toContain('insert into public.plan_modules (plan_id, module_id, limits)');
  });

  it('does not invent price or tenant subscription terms not represented by the schema', () => {
    expect(migration).not.toContain('monthly_price');
    expect(migration).not.toContain('subscriber_count');
    expect(migration).toContain(
      'revoke all on function public.save_platform_subscription_plan(uuid, text, boolean, uuid[], uuid) from public, anon',
    );
  });
});

describe('platform subscription plan workspace web contract', () => {
  it('validates both real RPC payloads and uses the shared compact toast', () => {
    expect(api).toContain('const resultSchema = z.object({');
    expect(api).toContain("rpc('get_platform_subscription_plan_workspace'");
    expect(api).toContain("rpc('save_platform_subscription_plan'");
    expect(workspace).toContain("from '@/components/ui/toast'");
    expect(workspace).toContain("title: 'Plan saved'");
  });

  it('uses shadcn cards/dialogs and routes the real Super Admin screen', () => {
    expect(workspace).toContain("from '@/components/ui/dialog'");
    expect(workspace).toContain("from '@/components/ui/card'");
    expect(workspace).toContain('Feature comparison');
    expect(route).toContain("role === 'super-admin' && slug[0] === 'plans-features'");
    expect(route.indexOf('<SubscriptionPlanWorkspace')).toBeLessThan(
      route.indexOf('<ProductionDataUnavailable'),
    );
  });
});
