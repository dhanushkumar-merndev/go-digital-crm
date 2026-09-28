import { execSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202609280001_quick_book_lead.sql');
const api = source('src/features/sales/sales-document-api.ts');
const dialogs = source('src/features/sales/sales-document-dialogs.tsx');
const workspace = source('src/features/sales/sales-document-workspace.tsx');
const quotationView = source('src/features/sales/quotation-create-view.tsx');
const caseDialogs = source('src/features/operations/operational-case-dialogs.tsx');
const caseWorkspace = source('src/features/operations/operational-case-workspace.tsx');
const cache = source('src/features/sales-consultant/sales-consultant-cache.ts');

describe('quick_book_lead contract', () => {
  it('composes the existing quotation and booking RPCs instead of re-implementing them', () => {
    expect(migration).toContain('public.save_quotation(');
    expect(migration).toContain(
      "public.transition_quotation_status(\n      quotation_id, quotation_version, 'SENT'",
    );
    expect(migration).toContain("'ACCEPTED', presented_reason");
    expect(migration).toContain('public.create_booking_from_quotation(');
    expect(migration).not.toMatch(/insert into public\.(bookings|quotations)\b/);
  });

  it('requires both quotation and booking rights and refuses pending approval', () => {
    expect(migration).toContain("has_permission(current_organization_id, 'quotation.manage')");
    expect(migration).toContain("has_permission(current_organization_id, 'booking.manage')");
    expect(migration).toContain("'QUICK_BOOKING_PERMISSION_REQUIRED'");
    expect(migration.match(/'QUOTATION_APPROVAL_REQUIRED'/g)).toHaveLength(2);
  });

  it("only books an existing quotation that belongs to the lead and the caller's scope", () => {
    expect(migration).toContain('and source_row.lead_id = target_lead_id;');
    expect(migration).toContain('app_private.can_access_record(');
    expect(migration).toContain("'QUOTATION_VERSION_CONFLICT'");
    expect(migration).toContain("'QUOTATION_ALREADY_BOOKED'");
  });

  it('derives a stable request id per step so a retry replays instead of duplicating', () => {
    for (const step of ['save', 'sent', 'accepted', 'booking'])
      expect(migration).toContain(`md5(target_request_id::text || ':quick-book:${step}')::uuid`);
    expect(migration).toContain(':booking.quick_created:');
  });

  it('is callable only by signed-in users', () => {
    expect(migration).toMatch(
      /revoke all on function public\.quick_book_lead\([\s\S]*?\) from public, anon;/,
    );
    expect(migration).toMatch(
      /grant execute on function public\.quick_book_lead\([\s\S]*?\) to authenticated;/,
    );
  });
});

describe('lead-to-booking UI combinations', () => {
  it("reads a lead's bookable quotations through the (organization_id, lead_id) index", () => {
    expect(api).toContain(".eq('organization_id', organizationId)");
    expect(api).toContain(".eq('lead_id', leadId)");
    expect(api).toContain(".order('created_at', { ascending: false })");
    expect(api).not.toContain(".select('*')");
  });

  it('offers booking from a lead, a quotation row and the pricing screen', () => {
    expect(dialogs).toContain("const mode = priced ? 'priced' : leadId ? 'lead' : 'accepted';");
    expect(dialogs).toContain('Price and book');
    expect(workspace).toContain('leadId={bookingLeadId}');
    expect(workspace).toContain('Book now');
    expect(quotationView).toContain('Book now');
    expect(quotationView).toContain('canBook && !requiresApproval');
  });

  it('keys the sales document list so the shared cache invalidation reaches it', () => {
    expect(cache).toContain(
      "salesDocumentWorkspace: (scope: Scope) => ['sales-document-workspace', ...scope]",
    );
    expect(workspace).toContain(
      "queryKey: ['sales-document-workspace', ...queryScope, kind, requestQuery]",
    );
  });

  it('uses the searchable picker for operational case bookings', () => {
    expect(caseDialogs).toContain('<SearchSelect');
    expect(caseDialogs).not.toContain('case-booking-search');
    expect(caseWorkspace).toContain('optionQueryOptions({');
  });
});

describe('Lost leads stay closed to sales documents', () => {
  const lostGuard = source(
    'supabase/migrations/202609280002_lost_lead_blocks_quotation_and_booking.sql',
  );

  it('patches quotation save, send/accept and booking with one refusal code', () => {
    for (const signature of [
      'public.save_quotation(uuid,bigint,uuid,jsonb,uuid)',
      'public.transition_quotation_status(uuid,bigint,text,text,uuid)',
      'public.create_booking_from_quotation(uuid,bigint,numeric,boolean,boolean,date,uuid)',
    ])
      expect(lostGuard).toContain(`'${signature}'::regprocedure`);
    expect(lostGuard).toContain("message = ''LEAD_IS_LOST''");
    expect(lostGuard).toContain("normalized_status in (''SENT'', ''ACCEPTED'')");
    expect(lostGuard).toContain("raise exception 'LOST_LEAD_SALES_DOCUMENT_GUARD_NOT_APPLIED'");
  });

  it('asserts each patch anchor matches exactly once', () => {
    expect(lostGuard.match(/_ANCHOR_NOT_UNIQUE/g)).toHaveLength(3);
  });

  it('explains the refusal in the booking and quotation screens', () => {
    expect(dialogs).toContain("case 'LEAD_IS_LOST':");
    expect(quotationView).toContain("=== 'LEAD_IS_LOST'");
  });
});

describe('version conflicts return 409 instead of retrying', () => {
  const conflictMigration = source(
    'supabase/migrations/202609280003_version_conflict_http_409.sql',
  );
  const helper = source('src/lib/supabase/version-conflict.ts');

  it('rewrites every live 40001 raise to PT409 and verifies none remain', () => {
    expect(conflictMigration).toContain("'errcode = ''PT409''', 'g'");
    expect(conflictMigration).toContain("raise exception 'VERSION_CONFLICT_40001_STILL_RAISED'");
  });

  it('never raises 40001 again in a later migration', () => {
    const later = readdirSync(join(process.cwd(), 'supabase/migrations'))
      .filter((name) => name > '202609280003_version_conflict_http_409.sql')
      .filter((name) => /errcode\s*=\s*'40001'/.test(source(`supabase/migrations/${name}`)));
    expect(later).toEqual([]);
  });

  it('recognises both codes in the web client', () => {
    expect(helper).toContain("code === 'PT409' || code === '40001'");
    const direct = execSync('grep -rln "\'40001\'" src || true', { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .filter((file) => !file.endsWith('src/lib/supabase/version-conflict.ts'));
    expect(direct).toEqual([]);
  });
});
