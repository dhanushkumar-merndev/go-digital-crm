import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CallVersionConflictError,
  isCallVersionConflict,
  parseCallQuery,
  toCallQueryString,
} from '../../src/features/calls/call-workspace-query';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202608150018_calls_workspace.sql');
const api = source('src/features/calls/call-workspace-api.ts');
const workspace = source('src/features/calls/call-workspace.tsx');
const route = source('src/app/[role]/[[...slug]]/page.tsx');

function section(start: string, end: string) {
  const startIndex = migration.indexOf(start);
  const endIndex = migration.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return migration.slice(startIndex, endIndex);
}

describe('calls workspace query boundary', () => {
  const list = section(
    'create or replace function public.get_call_workspace_page(',
    'create or replace function public.get_call_party_options(',
  );

  it('uses bounded server pagination, allowlisted filters, stable order, and a KPI bundle', () => {
    expect(list).toContain('target_page_size not in (25, 50, 100)');
    expect(list).toContain('INVALID_CALL_STATUS_FILTER');
    expect(list).toContain('INVALID_CALL_OUTCOME_FILTER');
    expect(list).toContain('INVALID_CALL_SOURCE_FILTER');
    expect(list).toContain('INVALID_CALL_SORT');
    expect(list).toContain('limit target_page_size');
    expect(list).toContain('offset (target_page - 1) * target_page_size');
    expect(list.indexOf('from page_base page_row')).toBeLessThan(
      list.indexOf('from public.call_recordings recording_source'),
    );
    expect(list).toContain('id asc');
    expect(list).toContain("'kpis', jsonb_build_object(");
    expect(list).toContain("'trend', coalesce(");
  });

  it('enforces tenant, branch, team and owner scope before joins expose call context', () => {
    expect(list).toContain("app_private.has_permission(current_organization_id, 'call.view')");
    expect(list).toContain('app_private.can_access_record(');
    expect(list).toContain('call_row.organization_id = current_organization_id');
    expect(list).toContain('app_private.can_access_customer(');
    expect(list).toContain('app_private.can_access_lead(');
  });

  it('returns recording availability but never a raw provider or object-storage locator', () => {
    expect(list).toContain("file_row.resource_type = 'call'");
    expect(list).toContain("'recording_available', page_row.object_file_id is not null");
    expect(list).not.toContain("'object_key'");
    expect(list).not.toContain("'bucket'");
    expect(list).not.toContain('temporary_url');
    expect(list).not.toContain('recording_url');
  });
});

describe('manual call mutation boundary', () => {
  const create = section(
    'create or replace function public.create_manual_call(',
    'create or replace function public.finalize_manual_call(',
  );
  const finalize = section('create or replace function public.finalize_manual_call(', 'commit;');

  it('logs only authorized scoped manual records and audits an idempotent request', () => {
    expect(create).toContain("app_private.has_permission(target_organization_id, 'call.create')");
    expect(create).toContain('app_private.can_access_record(');
    expect(create).toContain('CALL_LEAD_NOT_AUTHORIZED');
    expect(create).toContain('CALL_CUSTOMER_NOT_AUTHORIZED');
    expect(create).toContain("'PERSONAL_MANUAL'");
    expect(create).toContain('IDEMPOTENCY_KEY_REQUIRED');
    expect(create).toContain('IDEMPOTENCY_KEY_REUSED');
    expect(create).toContain("'call.manual_created'");
    expect(create).toContain('insert into public.audit_logs');
    expect(create).toContain('insert into public.activities');
  });

  it('finalizes with optimistic concurrency and never mutates a provider call', () => {
    expect(finalize).toContain(
      "app_private.has_permission(call_record.organization_id, 'call.update')",
    );
    expect(finalize).toContain('for update');
    expect(finalize).toContain('CALL_VERSION_CONFLICT');
    expect(finalize).toContain("call_record.call_source <> 'PERSONAL_MANUAL'");
    expect(finalize).toContain('PROVIDER_CALL_MUTATION_DENIED');
    expect(finalize).toContain('target_ended_at > call_record.started_at + interval');
    expect(finalize).toContain('version = call_row.version + 1');
    expect(finalize).toContain("'call.manual_finalized'");
  });

  it('closes direct browser writes and fixes provider idempotency without collapsing manual calls', () => {
    expect(migration).toContain(
      'drop constraint if exists calls_organization_id_connection_id_provider_call_id_key',
    );
    expect(migration).toContain('calls_provider_external_unique_idx');
    expect(migration).toContain('revoke insert, update, delete on public.calls');
    expect(migration).toContain('call_recordings_validate_object');
    expect(migration).toContain('call_recordings_call_org_fk');
    expect(migration).toContain('call_transcripts_call_org_fk');
  });

  it('invalidates the shared tenant communications topic for child processing updates', () => {
    expect(migration).toContain('realtime_call_recordings_invalidate');
    expect(migration).toContain('realtime_call_transcripts_invalidate');
    expect(migration).toContain('realtime_ai_call_summaries_invalidate');
    expect(migration).toContain("broadcast_tenant_invalidation('communications')");
  });
});

describe('calls web contract', () => {
  it('uses TanStack Query/Table, the shared EChart, realtime invalidation, and completed route slugs', () => {
    expect(workspace).toContain("from '@tanstack/react-query'");
    expect(workspace).toContain("from '@tanstack/react-table'");
    expect(workspace).toContain('<EChart');
    expect(workspace).toContain("resource: 'communications'");
    expect(workspace).toContain('useDebouncedValue(partySearch, 300)');
    expect(route).toContain("spec.category === 'calls'");
    expect(route).toContain('<CallWorkspace');
  });

  it('downloads recordings exclusively through the existing presign-download boundary', () => {
    expect(api).toContain("'presign-download'");
    expect(api).toContain('object_file_id: objectFileId');
    expect(workspace).toContain('createCallRecordingDownload');
    expect(workspace).not.toContain('providerRecordingUrl');
    expect(workspace).not.toContain('object_key');
  });
});

describe('call URL and concurrency helpers', () => {
  it('accepts only recognized page, filter, and sort state', () => {
    expect(
      parseCallQuery(
        new URLSearchParams(
          'page=-2&pageSize=77&status=malicious&outcome=busy&source=provider&sort=nope&q=  Ravi  ',
        ),
      ),
    ).toEqual({
      page: 1,
      pageSize: 25,
      search: 'Ravi',
      status: 'all',
      outcome: 'busy',
      source: 'provider',
      sort: 'started:desc',
    });
  });

  it('preserves meaningful URL state and recognizes only the version conflict signal', () => {
    expect(
      toCallQueryString({
        page: 2,
        pageSize: 50,
        search: '98765',
        status: 'completed',
        outcome: 'connected',
        source: 'personal-manual',
        sort: 'duration:desc',
      }),
    ).toBe(
      'page=2&pageSize=50&q=98765&status=completed&outcome=connected&source=personal-manual&sort=duration%3Adesc',
    );
    expect(isCallVersionConflict(new CallVersionConflictError())).toBe(true);
    expect(isCallVersionConflict({ code: '40001', message: 'CALL_VERSION_CONFLICT' })).toBe(true);
    expect(isCallVersionConflict({ code: '42501', message: 'PERMISSION_DENIED' })).toBe(false);
  });
});
