import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '202608150011_customer_workspace.sql'),
  'utf8',
);

function section(start: string, end: string) {
  const startIndex = migration.indexOf(start);
  const endIndex = migration.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return migration.slice(startIndex, endIndex);
}

describe('customer match resolution transaction', () => {
  const matching = section(
    'create or replace function public.possible_customer_matches(',
    'create or replace function public.resolve_lead_customer(',
  );
  const resolution = section(
    'create or replace function public.resolve_lead_customer(',
    'create or replace function public.get_customer_workspace_page(',
  );

  it('denies unauthenticated, unauthorized, out-of-scope, and stale decisions', () => {
    expect(matching).toContain(
      "app_private.has_permission(lead_row.organization_id, 'customer.link')",
    );
    expect(resolution).toContain('AUTHENTICATION_REQUIRED');
    expect(resolution).toContain(
      "app_private.has_permission(lead_row.organization_id, 'customer.link')",
    );
    expect(resolution).toContain('app_private.can_access_record(');
    expect(resolution).toContain('LEAD_VERSION_CONFLICT');
    expect(resolution).toContain('for update');
    expect(resolution).toContain('LEAD_ALREADY_LINKED');
    expect(resolution).toContain('IDEMPOTENCY_KEY_REQUIRED');
    expect(resolution).toContain('IDEMPOTENCY_KEY_REUSED');
    expect(resolution).toContain("'replayed', true");
  });

  it('supports only explicit link/create choices and never silently merges on contact match', () => {
    expect(resolution).toContain("resolution not in ('LINK_EXISTING', 'CREATE_NEW')");
    expect(resolution).toContain('CUSTOMER_NOT_POSSIBLE_MATCH');
    expect(resolution).toContain(
      "app_private.has_permission(lead_row.organization_id, 'customer.create')",
    );
    expect(resolution).toContain('insert into public.customers');
    expect(resolution).toContain('returning id into new_customer_id');
    expect(resolution).not.toMatch(/on conflict[\s\S]*customers/i);
  });

  it('validates payloads, preserves tenant boundaries, links atomically, and audits the decision', () => {
    expect(resolution).toContain('INVALID_CUSTOMER_PAYLOAD');
    expect(resolution).toContain('INVALID_CUSTOMER_NAME');
    expect(resolution).toContain('INVALID_PHONE');
    expect(resolution).toContain("phone_value !~ '^[0-9+(). -]+$'");
    expect(resolution).toContain("phone_digits !~ '^[0-9]{7,15}$'");
    expect(resolution).toContain('INVALID_EMAIL');
    expect(resolution).toContain('customer_row.organization_id = lead_row.organization_id');
    expect(resolution).toContain("perform set_config('app.link_customer_rpc', 'on', true)");
    expect(resolution).toContain('insert into public.activities');
    expect(resolution).toContain('insert into public.audit_logs');
    expect(resolution).toContain("'possible_match_count', possible_match_count");
    expect(resolution).toContain("'reason', btrim(resolution_reason)");
  });

  it('closes direct browser insert bypasses and grants only the reviewed RPC', () => {
    expect(migration).toContain('drop policy if exists customers_insert on public.customers');
    expect(migration).toContain(
      'revoke insert, update on public.customers from anon, authenticated',
    );
    expect(migration).toContain(
      'revoke all on function public.link_lead_to_customer(uuid, uuid, text)',
    );
    expect(migration).toContain(
      'grant execute on function public.resolve_lead_customer(uuid, timestamptz, text, text, uuid, uuid, jsonb)',
    );
    expect(migration).toContain('customer_resolution_request_unique_idx');
  });
});

describe('customer list and Customer 360 query boundary', () => {
  const list = section(
    'create or replace function public.get_customer_workspace_page(',
    'create or replace function public.get_customer_360(',
  );
  const detail = section('create or replace function public.get_customer_360(', 'commit;');

  it('uses server-side page sizes, search, stable ordering, and scoped aggregate queries', () => {
    expect(list).toContain('target_page_size not in (25, 50, 100)');
    expect(list).toContain('SEARCH_TOO_LONG');
    expect(list).toContain('INVALID_CUSTOMER_SORT');
    expect(list).toContain('limit target_page_size');
    expect(list).toContain('offset (target_page - 1) * target_page_size');
    expect(list).toContain('id asc');
    expect(list).toContain(
      'app_private.can_access_customer(customer_row.organization_id, customer_row.id)',
    );
    expect(list).toContain("app_private.has_permission(current_organization_id, 'customer.view')");
    expect(list).toContain("'kpis', jsonb_build_object(");
    expect(list).not.toContain('select * from public.customers');
  });

  it('fails closed for cross-tenant or out-of-scope detail requests', () => {
    expect(detail).toContain('CUSTOMER_NOT_FOUND');
    expect(detail).toContain(
      "app_private.has_permission(customer_row.organization_id, 'customer.view')",
    );
    expect(detail).toContain(
      'app_private.can_access_customer(customer_row.organization_id, customer_row.id)',
    );
    expect(detail).toContain(
      "raise exception using errcode = '42501', message = 'PERMISSION_DENIED'",
    );
  });

  it('filters each Customer 360 section by its domain permission and record scope', () => {
    for (const permission of [
      'lead.view',
      'call.view',
      'message.view',
      'test_drive.manage',
      'quotation.manage',
      'booking.manage',
      'document.download',
    ]) {
      expect(detail).toContain(`'${permission}'`);
    }
    for (const guard of [
      'app_private.can_access_record(',
      'app_private.can_access_call(',
      'app_private.can_access_conversation(',
      'app_private.can_access_test_drive(',
      'app_private.can_access_quotation(',
      'app_private.can_access_booking(',
      'app_private.can_access_branch(',
    ]) {
      expect(detail).toContain(guard);
    }
    expect(detail).toContain("'section_access', jsonb_build_object(");
    expect(detail).toContain(
      'or (lead_access and app_private.can_access_lead(appointment_row.lead_id))',
    );
    expect(detail).not.toContain('appointment_row.lead_id is null or not lead_access');
    expect(detail).not.toContain("'object_key', object_row.object_key");
    expect(detail).not.toContain("'bucket', object_row.bucket");
    expect(detail).not.toContain('transcript_text');
  });

  it('keeps the current opportunity response contract free of duplicate JSON keys', () => {
    const currentOpportunity = section(
      'select item.data into current_opportunity',
      'select coalesce(jsonb_agg(item.data order by item.updated_at desc, item.id)',
    );
    expect(currentOpportunity.match(/'assigned_user_name'/g)).toHaveLength(1);
  });
});
