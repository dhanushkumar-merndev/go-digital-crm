import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260930100000_marketing_campaign_spend_kpis.sql'),
  'utf8',
);

function section(start: string, end: string) {
  const startIndex = migration.indexOf(start);
  const endIndex = migration.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return migration.slice(startIndex, endIndex);
}

describe('marketing campaign spend and cost KPIs', () => {
  it('keeps spend in a tenant-scoped, read-only-to-clients daily table', () => {
    expect(migration).toContain('create table public.marketing_campaign_daily_metrics');
    expect(migration).toContain('constraint marketing_campaign_metric_campaign_org_fk');
    expect(migration).toContain('unique (organization_id, campaign_id, metric_date)');
    expect(migration).toContain("check (data_source in ('MANUAL', 'PROVIDER_SYNC'))");
    expect(migration).toContain(
      'check (clicks is null or impressions is null or clicks <= impressions)',
    );
    expect(migration).toContain(
      'alter table public.marketing_campaign_daily_metrics enable row level security',
    );
    expect(migration).toContain(
      'revoke insert, update, delete, truncate on public.marketing_campaign_daily_metrics from anon, authenticated',
    );
    expect(migration).toContain("('marketing_campaign_daily_metrics', 'DELETE', 779)");
  });

  it('attributes leads within lead scope and leaves cost null when no spend is recorded', () => {
    const stats = section(
      'create or replace function app_private.marketing_campaign_stats(',
      'create or replace function public.get_marketing_workspace_page(',
    );
    expect(stats).toContain(
      'lower(btrim(lead_row.campaign)) in (campaign.name_key, campaign.external_key)',
    );
    expect(stats).toContain("app_private.has_permission(target_organization_id, 'lead.view')");
    expect(stats).toContain('app_private.can_access_record(target_organization_id,');
    expect(stats).toContain('metric_totals.spend');
    expect(stats).not.toMatch(/coalesce\(metric_totals\.spend\s*[,)]/);
    expect(migration).toContain('create index if not exists leads_org_campaign_key_idx');
  });

  it('derives cost per lead only from campaigns that carry spend', () => {
    const page = section(
      'create or replace function public.get_marketing_workspace_page(',
      'create or replace function public.save_marketing_campaign(',
    );
    expect(page).toContain("'cost_per_lead'");
    expect(page).toContain("'cost_per_booking'");
    expect(page).toContain("'click_through_percent'");
    expect(page).toContain('where stat_spend is not null');
    expect(page).toContain("'can_manage', can_manage");
    expect(page).toContain('limit target_page_size offset (target_page - 1) * target_page_size');
    expect(page).not.toMatch(/budget_amount\s*\/\s*[a-z_]*leads/);
  });

  it('guards campaign writes with permission, scope, versioning and audit', () => {
    const save = section(
      'create or replace function public.save_marketing_campaign(',
      'create or replace function public.record_marketing_campaign_metrics(',
    );
    expect(save).toContain(
      "app_private.has_permission(current_organization_id, 'marketing.manage')",
    );
    expect(save).toContain("message = 'MARKETING_CAMPAIGN_SCOPE_DENIED'");
    expect(save).toContain("errcode = 'PT409', message = 'MARKETING_CAMPAIGN_VERSION_CONFLICT'");
    expect(save).toContain("audit_row.action = 'marketing_campaign.created'");
    expect(save).toContain("'marketing_campaign.updated'");
    expect(save).not.toContain("'40001'");
  });

  it('never lets a manual entry overwrite a provider-synced day', () => {
    const record = section(
      'create or replace function public.record_marketing_campaign_metrics(',
      'create or replace function public.get_marketing_lead_source_connections(',
    );
    expect(record).toContain("previous.data_source = 'PROVIDER_SYNC'");
    expect(record).toContain(
      "where public.marketing_campaign_daily_metrics.data_source = 'MANUAL'",
    );
    expect(record).toContain("message = 'PROVIDER_METRICS_LOCKED'");
    expect(record).toContain('target_metric_date > today');
    expect(record).toContain("'marketing_campaign_metrics.recorded'");
  });

  it('lets marketing managers map ad lead-source columns but nothing else', () => {
    expect(migration).toContain(
      "array['meta', 'google_ads', 'indiamart', 'carwale', 'cardekho', 'justdial']",
    );
    for (const name of ['get_integration_field_mappings', 'save_integration_field_mappings']) {
      const body = section(`create or replace function public.${name}(`, '$function$;');
      expect(body).toContain(
        "app_private.has_permission(current_organization_id, 'marketing.manage')",
      );
      expect(body).toContain('app_private.marketing_mappable_lead_providers()');
    }
    const connections = section(
      'create or replace function public.get_marketing_lead_source_connections(',
      'create or replace function public.get_integration_field_mappings(',
    );
    expect(connections).not.toMatch(/credential|connection_config|token/);
  });
});
