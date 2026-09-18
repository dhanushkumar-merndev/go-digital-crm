import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202609160003_lead_model_search_rpc.sql');
const api = source('src/features/leads/lead-workspace-api.ts');
const workspace = source('src/features/leads/lead-workspace.tsx');

describe('lead interested model search contract', () => {
  it('protects model options by tenant, authentication, and lead permissions', () => {
    expect(migration).toContain('create or replace function public.get_interested_model_options');
    expect(migration).toContain('app_private.current_tenant_organization()');
    expect(migration).toContain("app_private.has_permission(org, 'lead.create')");
    expect(migration).toContain("app_private.has_permission(org, 'lead.view')");
    expect(migration).toContain("app_private.has_permission(org, 'lead.manage')");
    expect(migration).toContain('app_private.can_access_branch(org, target_branch_id)');
  });

  it('bounds search length and limits output to top 5 results by default', () => {
    expect(migration).toContain('target_limit integer default 5');
    expect(migration).toContain('least(greatest(coalesce(target_limit, 5), 1), 20)');
    expect(migration).toContain(
      'case when target_branch_id is not null and in_stock then 0 else 1 end',
    );
  });

  it('exports fetchInterestedModelOptions in lead-workspace-api', () => {
    expect(api).toContain('export async function fetchInterestedModelOptions');
    expect(api).toContain("rpc('get_interested_model_options'");
    expect(api).toContain('target_limit: params.limit ?? 5');
  });

  it('wires SearchSelect with debounced search in LeadCreateDialog', () => {
    expect(workspace).toContain('SearchSelect');
    expect(workspace).toContain('fetchInterestedModelOptions');
    expect(workspace).toContain('debouncedModelSearch');
    expect(workspace).toContain('useDebouncedValue(modelSearch, 250)');
    expect(workspace).toContain('modelSelectOptions');
  });
});
