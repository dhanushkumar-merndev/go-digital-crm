import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  InvalidProviderReceiptError,
  providerEventRetryDelaySeconds,
  readGoogleLeadReceipt,
  readMetaLeadReceipt,
  readWhatsAppInboundReceipt,
  readWhatsAppStatusReceipt,
} from '../../src/lib/providers/provider-event-receipts';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202608150009_provider_event_dispatch.sql');
const worker = source('trigger/provider-event-dispatch.ts');
const metaIngress = source('supabase/functions/provider-webhook-meta/index.ts');
const googleIngress = source('supabase/functions/provider-webhook-generic/index.ts');
const whatsappIngress = source('supabase/functions/provider-webhook-whatsapp/index.ts');
const providerRouting = source('supabase/functions/_shared/provider-routing.ts');

describe('provider event receipt readers', () => {
  it('reads the exact Meta receipt persisted by webhook ingress', () => {
    const event = {
      eventId: 'leadgen:lead-17',
      leadId: 'lead-17',
      pageId: 'page-4',
      formId: 'form-2',
      occurredAt: '2026-08-15T10:00:00.000Z',
    };
    expect(readMetaLeadReceipt({ event }, event.eventId)).toEqual(event);
  });

  it('reconstructs a Google envelope without persisting its anti-spoofing key', () => {
    const payload = {
      lead_id: 'google-22',
      form_id: 123,
      campaign_id: 456,
      is_test: false,
      user_column_data: [
        { column_id: 'FULL_NAME', string_value: 'Aarav Sharma' },
        { column_id: 'PHONE_NUMBER', string_value: '9873100001' },
      ],
    };
    const receipt = readGoogleLeadReceipt(payload, 'google-lead:google-22');
    expect(receipt.envelope.leadId).toBe('google-22');
    expect(receipt.safePayload).not.toHaveProperty('google_key');
  });

  it('reconstructs the raw WhatsApp message and status receipt shapes', () => {
    const inbound = readWhatsAppInboundReceipt(
      {
        id: 'wamid.inbound',
        from: '919873100001',
        timestamp: '1786782000',
        type: 'text',
        text: { body: 'Please arrange a test drive.' },
      },
      'phone-1',
      'whatsapp-message:wamid.inbound',
    );
    expect(inbound).toMatchObject({
      phoneNumberId: 'phone-1',
      sender: '919873100001',
      body: 'Please arrange a test drive.',
    });
    expect(
      readWhatsAppInboundReceipt(
        {
          phone_number_id: 'phone-1',
          provider_payload: inbound.providerPayload,
        },
        'phone-1',
        'whatsapp-message:wamid.inbound',
      ),
    ).toMatchObject({ sender: '919873100001', phoneNumberId: 'phone-1' });

    const status = readWhatsAppStatusReceipt(
      {
        id: 'wamid.outbound',
        recipient_id: '919873100001',
        timestamp: '1786782010',
        status: 'delivered',
        biz_opaque_callback_data: '456c57e6-df49-4a22-a7b3-f8ced42f119d',
      },
      'phone-1',
      'whatsapp-status:wamid.outbound:delivered',
    );
    expect(status).toMatchObject({
      providerMessageId: 'wamid.outbound',
      applicationMessageId: '456c57e6-df49-4a22-a7b3-f8ced42f119d',
      status: 'DELIVERED',
    });
  });

  it('permanently rejects receipt identity mismatches and oversized payloads', () => {
    expect(() =>
      readMetaLeadReceipt(
        { event: { eventId: 'leadgen:one', leadId: 'one', pageId: 'page-1' } },
        'leadgen:two',
      ),
    ).toThrowError(InvalidProviderReceiptError);
    expect(() =>
      readMetaLeadReceipt(
        {
          event: {
            eventId: 'leadgen:one',
            leadId: 'one',
            pageId: 'x'.repeat(70_000),
          },
        },
        'leadgen:one',
      ),
    ).toThrowError('PROVIDER_EVENT_PAYLOAD_TOO_LARGE');
    expect(() =>
      readWhatsAppInboundReceipt(
        {
          phone_number_id: 'phone-other',
          provider_payload: {
            id: 'wamid.inbound',
            from: '919873100001',
            timestamp: '1786782000',
            type: 'text',
          },
        },
        'phone-1',
        'whatsapp-message:wamid.inbound',
      ),
    ).toThrowError('WHATSAPP_RECEIPT_ROUTE_MISMATCH');
  });

  it('uses deterministic, bounded exponential row retry delays', () => {
    const delays = Array.from({ length: 8 }, (_, index) =>
      providerEventRetryDelaySeconds(index + 1, 'leadgen:lead-17'),
    );
    expect(delays[0]).toBeGreaterThanOrEqual(30);
    expect(delays[7]).toBeLessThanOrEqual(3_600);
    expect(delays).toEqual([...delays].sort((left, right) => left - right));
  });
});

describe('durable provider event dispatch contract', () => {
  it('claims with skip-locked leases, recovers stale work, and caps attempts', () => {
    expect(migration).toContain('for update skip locked');
    expect(migration).toContain("event_row.processing_started_at < now() - interval '5 minutes'");
    expect(migration).toContain('event_row.attempt_count < 8');
    expect(migration).toContain("event_row.status = 'PENDING_RECONCILIATION'");
    expect(migration).toContain("safe_error_code = 'PROVIDER_EVENT_RETRY_EXHAUSTED'");
  });

  it('requires the service role and the exact worker lease for transitions', () => {
    expect(migration.match(/auth\.role\(\) <> 'service_role'/g)?.length).toBeGreaterThanOrEqual(5);
    expect(migration).toContain('event_row.processing_worker_id = target_worker_id');
    expect(migration).toContain('target_batch_size is null');
    expect(migration).toContain('target_payload_patch is null');
  });

  it('atomically persists inbound messages and applies monotonic delivery states', () => {
    expect(migration).toContain('public.ingest_whatsapp_inbound_message');
    expect(migration).toContain('public.apply_whatsapp_message_status');
    expect(migration).toContain(
      'on conflict (organization_id, conversation_id, provider_message_id)',
    );
    expect(migration).toContain('target_rank >= current_rank');
    expect(migration).toContain('provider_status_at = target_occurred_at');
  });

  it('derives application-level Meta/WhatsApp callbacks from unique tenant asset routes', () => {
    expect(migration).toContain('integration_provider_asset_route_unique_idx');
    expect(migration).toContain("external_resource_type in ('META_PAGE', 'WHATSAPP_PHONE_NUMBER')");
    expect(providerRouting).toContain(".from('integration_branch_mappings')");
    expect(providerRouting).toContain(".from('connected_accounts')");
    expect(providerRouting).toContain(".eq('status', 'CONNECTED')");
    expect(metaIngress).not.toContain("searchParams.get('connection_id')");
    expect(whatsappIngress).not.toContain("searchParams.get('connection_id')");
  });

  it('dispatches every durable MVP receipt through a bounded scheduled worker', () => {
    for (const eventType of [
      'META_LEADGEN',
      'GOOGLE_LEAD_FORM',
      'WHATSAPP_INBOUND_MESSAGE',
      'WHATSAPP_MESSAGE_STATUS',
    ])
      expect(worker).toContain(`event.event_type === '${eventType}'`);
    expect(worker).toContain("id: 'provider-event-dispatch'");
    expect(worker).toContain('queue: { concurrencyLimit: 1 }');
    expect(worker).toContain("ttl: '5m'");
    expect(worker).toContain("supabase.rpc('claim_provider_events'");
    expect(worker).toContain("supabase.rpc('complete_provider_event'");
    expect(worker).toContain("supabase.rpc('retry_provider_event'");
    expect(worker).toContain('AbortSignal.timeout(15_000)');
    expect(worker).toContain('value > 50');
    expect(worker).toContain('value > 10');
  });

  it('keeps webhook requests to signature/key validation and durable receipt writes', () => {
    expect(metaIngress).toContain('.upsert(');
    expect(whatsappIngress).toContain('.upsert(receipts');
    expect(googleIngress).toContain(".from('provider_events').insert");
    for (const ingress of [metaIngress, googleIngress, whatsappIngress]) {
      expect(ingress).toContain(".from('provider_events')");
      expect(ingress).toContain("'RECEIVED'");
      expect(ingress).not.toContain("rpc('ingest_provider_lead'");
      expect(ingress).not.toContain(".from('conversation_messages')");
    }
  });
});
