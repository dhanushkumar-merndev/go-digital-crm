import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LEAD_BULK_IMPORT_MAX_ROWS,
  parseLeadBulkImportCsv,
} from '../../src/features/leads/lead-bulk-import-csv';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202609050001_telecaller_lead_bulk_import.sql');
const edge = source('supabase/functions/lead-bulk-import/index.ts');
const worker = source('trigger/lead-bulk-import.ts');
const workspace = source('src/features/leads/lead-workspace.tsx');

describe('Telecaller lead bulk-import CSV', () => {
  it('accepts the template columns, quoted commas and canonical sources', () => {
    const preview = parseLeadBulkImportCsv(
      'customer_name,phone,email,source,source_detail,campaign,interested_model\r\n' +
        '"Ravi, Kumar",+919876543210,ravi@example.com,Manual,Walk-in,September,Nexon\r\n',
    );
    expect(preview.errors).toEqual([]);
    expect(preview.rows).toHaveLength(1);
    expect(preview.rows[0]).toMatchObject({
      rowNumber: 2,
      values: { customer_name: 'Ravi, Kumar', source: 'Manual' },
      errors: [],
    });
  });

  it('reports missing headers, invalid row data and exact duplicates before upload', () => {
    expect(parseLeadBulkImportCsv('name,phone\nRavi,123\n').errors[0]).toContain('Unknown column');
    const preview = parseLeadBulkImportCsv(
      'customer_name,phone,source\nRavi,123,Unknown\nRavi,123,Unknown\n',
    );
    expect(preview.rows[0].errors).toEqual([
      'Phone must contain 7–15 digits.',
      'Source is not one of the template values.',
    ]);
    expect(preview.rows[1].errors.at(-1)).toBe('Exact duplicate of row 2.');
  });

  it('enforces the same bounded batch size exposed by the server', () => {
    const rows = Array.from(
      { length: LEAD_BULK_IMPORT_MAX_ROWS + 1 },
      (_, index) => `Customer ${index},9190000${String(index).padStart(6, '0')},Manual`,
    );
    const preview = parseLeadBulkImportCsv(`customer_name,phone,source\n${rows.join('\n')}`);
    expect(preview.errors).toContain(
      `A single import can contain at most ${LEAD_BULK_IMPORT_MAX_ROWS} leads.`,
    );
  });
});

describe('Telecaller lead bulk-import boundary', () => {
  it('is tenant scoped, Telecaller-only, idempotent, RLS protected and audited', () => {
    for (const marker of [
      'enable row level security',
      "role_row.role_key = 'telecaller_bdc'",
      'app_private.can_access_branch',
      'unique (organization_id, request_id)',
      "'lead.bulk_import_requested'",
      "'lead.bulk_import_completed'",
    ]) {
      expect(migration).toContain(marker);
    }
  });

  it('revalidates server-side and reuses create_lead under the original actor', () => {
    expect(migration).toContain('jsonb_array_length(target_rows) not between 1 and 250');
    expect(migration).toContain("'request.jwt.claims'");
    expect(migration).toContain('created_lead_id := public.create_lead(');
    expect(migration).toContain('row_errors = errors');
  });

  it('queues one retry-safe background task and keeps provider secrets server-side', () => {
    expect(edge).toContain('/api/v1/tasks/lead-bulk-import/trigger');
    expect(edge).toContain('idempotencyKey: `lead-bulk-import:${importRecord.id}`');
    expect(edge).toContain("Deno.env.get('TRIGGER_SECRET_KEY')");
    expect(worker).toContain("id: 'lead-bulk-import'");
    expect(worker).toContain("supabase.rpc('process_lead_bulk_import'");
    expect(worker).toContain("supabase.rpc('retry_lead_bulk_import'");
  });

  it('shows the import action only in the Telecaller lead workspace', () => {
    expect(workspace).toContain("role === 'telecaller' ? (");
    expect(workspace).toContain('<LeadBulkImportDialog');
    expect(workspace).toContain('Import CSV');
  });
});
