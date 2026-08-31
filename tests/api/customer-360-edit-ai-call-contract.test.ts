import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(path: string) {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
}

const migration = source('supabase/migrations/202608250003_customer_360_edit_and_ai_calls.sql');
const customerApi = source('src/features/customers/customer-workspace-api.ts');
const customerWorkspace = source('src/features/customers/customer-360-workspace.tsx');
const customerActions = source('src/features/customers/customer-360-actions.tsx');
const callApi = source('src/features/calls/call-workspace-api.ts');
const callStart = source('supabase/functions/call-provider-start/index.ts');
const callWorkspace = source('src/features/calls/call-workspace.tsx');
const workWorkspace = source('src/features/work/workspace.tsx');

describe('Customer 360 edit contract', () => {
  it('provides a contextual creation action for each editable Customer 360 tab', () => {
    // Calls and Conversations are no longer Customer 360 tabs, so neither has
    // a contextual create action here any more.
    for (const label of [
      'Add lead',
      'Add follow-up',
      'Add appointment',
      'Schedule test drive',
      'Create quotation',
      'Create booking',
      'Add vehicle',
      'Upload document',
    ]) {
      expect(customerWorkspace).toContain(label);
    }
    expect(customerWorkspace).toContain('router.push(`/${role}/follow-ups?action=create`)');
    expect(customerWorkspace).toContain('router.push(`/${role}/appointments?action=create`)');
    expect(customerWorkspace).toContain('router.push(`/${role}/test-drives?action=create`)');
    expect(customerWorkspace).toContain('router.push(`/${role}/quotations?action=create`)');
    expect(customerWorkspace).toContain('router.push(`/${role}/bookings?action=create`)');
    expect(customerWorkspace).toContain('CustomerDocumentUploadDialog');
    expect(callWorkspace).toContain("searchParams.get('action') === 'create'");
    expect(workWorkspace).toContain("searchParams.get('action') === 'create'");
  });

  it('uploads customer documents through the existing private object-upload boundary', () => {
    expect(customerApi).toContain("resource_type: 'customer'");
    expect(customerApi).toContain("'presign-upload'");
    expect(customerApi).toContain("'object-upload-finalize'");
    expect(customerActions).toContain('Upload customer document');
    expect(customerActions).toContain('CustomerDocumentUploadDialog');
  });

  it('returns to the actual previous workspace view before falling back to customers', () => {
    expect(customerWorkspace).toContain('const returnToPreviousPage');
    expect(customerWorkspace).toContain('window.history.length > 1');
    expect(customerWorkspace).toContain('router.back()');
    expect(customerWorkspace).toContain('router.replace(`/${role}/customers`)');
  });

  it('uses a scoped, optimistic and audited customer mutation', () => {
    expect(migration).toContain("('customer.update', 'customers'");
    expect(migration).toContain('create or replace function public.update_customer_360');
    expect(migration).toContain('expected_customer_updated_at timestamptz');
    expect(migration).toContain('target_request_id uuid');
    expect(migration).toContain("message = 'CUSTOMER_VERSION_CONFLICT'");
    expect(migration).toContain(
      "app_private.has_permission(actor_row.organization_id, 'customer.update')",
    );
    expect(migration).toContain(
      'app_private.can_access_customer(actor_row.organization_id, target_customer_id)',
    );
    expect(migration).toContain("'customer.updated'");
    expect(migration).toContain('customer_update_request_unique_idx');
    expect(migration).not.toMatch(
      /delete\s+from\s+public\.(customers|customer_contacts|customer_addresses|customer_vehicles)/i,
    );
  });

  it('loads every editable customer detail through one authorized profile endpoint', () => {
    expect(migration).toContain('create or replace function public.get_customer_360_edit_data');
    expect(migration).toContain("upper(definition_row.module) = 'CUSTOMERS'");
    expect(migration).toContain('from public.customer_contacts contact_row');
    expect(migration).toContain('from public.customer_addresses address_row');
    expect(migration).toContain('from public.customer_vehicles vehicle_source');
    expect(customerApi).toContain("rpc('get_customer_360_edit_data'");
    expect(customerApi).toContain("rpc('update_customer_360'");
    expect(customerActions).toContain('Edit customer');
    expect(customerActions).toContain('Contact identifiers');
    expect(customerActions).toContain('Addresses');
    expect(customerActions).toContain('Vehicles');
    expect(customerActions).toContain('Custom information');
  });
});

describe('Customer 360 AI-call branch scope contract', () => {
  it('only resolves AI-capable Twilio connections mapped to the visible lead branch', () => {
    expect(migration).toContain('create or replace function public.get_customer_ai_call_options');
    expect(migration).toContain(
      'connection_row.connection_config @> \'{"capabilities":["AI_VOICE_CALLING"]}\'::jsonb',
    );
    expect(migration).toContain("connection_row.scope_mode = 'ALL_BRANCHES'");
    expect(migration).toContain('mapping_row.branch_id = lead_row.branch_id');
    expect(migration).toContain('app_private.can_access_record(');
    expect(migration).toContain(
      'create or replace function public.create_ai_provider_call_request',
    );
    expect(migration).toContain("message = 'AI_CALL_CONNECTION_NOT_AUTHORIZED'");
  });

  it('uses the AI-only provider path from the customer AI call dialog', () => {
    expect(customerActions).toContain('CustomerAiCallDialog');
    expect(customerActions).toContain('fetchCustomerAiCallOptions(customerId, signal)');
    expect(customerActions).toContain('aiMode: true');
    expect(callApi).toContain('aiMode?: boolean');
    expect(callStart).toContain('ai_mode: z.boolean().default(false)');
    expect(callStart).toContain(
      "'create_ai_provider_call_request' : 'create_provider_call_request'",
    );
  });
});
