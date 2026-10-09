import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ rpc }) }));
import {
  fetchMarketingAutomationWorkspace,
  fetchMarketingReviewCustomerOptions,
  createSmsFallbackCampaign,
  fetchMarketingDripBuilderOptions,
} from '../../src/features/marketing/marketing-automation-api';

const id = '65d2a775-8b6d-45f6-a031-52b0be7b1125';
function workspace(timestamp: string) {
  return {
    organization_id: id,
    drip_kpis: { total: 1, active: 1, paused: 0, steps: 1 },
    campaigns: [
      {
        id,
        name: 'Welcome',
        description: null,
        branch_id: null,
        default_channel: 'EMAIL',
        status: 'ACTIVE',
        starts_at: timestamp,
        step_count: 1,
        version: 1,
        updated_at: timestamp,
      },
    ],
    review_kpis: { queued: 1, sent_today: 0, delivered: 0, completed: 0 },
    reviews: [
      {
        id,
        customer_id: id,
        customer_name: 'Customer',
        customer_phone: null,
        booking_id: null,
        booking_number: null,
        channel: 'EMAIL',
        status: 'QUEUED',
        scheduled_for: timestamp,
        sent_at: null,
        created_at: timestamp,
        updated_at: timestamp,
        version: 1,
      },
    ],
  };
}

describe('marketing automation RPC responses', () => {
  beforeEach(() => rpc.mockReset());

  it.each([
    '2026-10-09T10:12:13.123456+00:00',
    '2026-10-09T15:42:13+05:30',
    '2026-10-09T10:12:13Z',
  ])('accepts campaign and review timestamptz values: %s', async (timestamp) => {
    const data = workspace(timestamp);
    rpc.mockResolvedValue({ data, error: null });
    await expect(fetchMarketingAutomationWorkspace()).resolves.toEqual(data);
    expect(rpc).toHaveBeenCalledWith('get_marketing_automation_workspace', {
      target_timezone: 'Asia/Kolkata',
    });
  });

  it('accepts PostgreSQL timestamps in review customer options', async () => {
    const data = [
      {
        customer_id: id,
        customer_name: 'Customer',
        phone: null,
        booking_id: id,
        booking_number: 'BK-1',
        branch_id: id,
        updated_at: '2026-10-09T10:12:13+00:00',
      },
    ];
    rpc.mockResolvedValue({ data, error: null });
    await expect(fetchMarketingReviewCustomerOptions('Customer')).resolves.toEqual(data);
  });

  it.each(['invalid', '2026-10-09T10:12:13'])(
    'rejects malformed or timezone-less timestamps: %s',
    async (timestamp) => {
      rpc.mockResolvedValue({ data: workspace(timestamp), error: null });
      await expect(fetchMarketingAutomationWorkspace()).rejects.toThrow();
    },
  );

  it('preserves genuine backend permission failures', async () => {
    const error = { code: '42501', message: 'MARKETING_AUTOMATION_VIEW_PERMISSION_REQUIRED' };
    rpc.mockResolvedValue({ data: null, error });
    await expect(fetchMarketingAutomationWorkspace()).rejects.toEqual(error);
  });

  it('saves the SMS fallback as a zero-delay new-lead campaign with the missing-email condition', async () => {
    rpc.mockResolvedValue({
      data: { id, status: 'DRAFT', version: 1, replayed: false },
      error: null,
    });
    await createSmsFallbackCampaign({
      name: 'Thank-you',
      branchId: id,
      sources: ['Other'],
      templateId: id,
      variableMap: { NAME: 'customer_first_name' },
      requestId: id,
    });
    expect(rpc).toHaveBeenCalledWith(
      'save_marketing_drip_campaign',
      expect.objectContaining({
        target_branch_id: id,
        target_payload: expect.objectContaining({
          trigger_type: 'LEAD_CREATED',
          trigger_conditions: { sources: ['Other'], models: [], email_presence: 'MISSING' },
          steps: [
            {
              step_order: 1,
              delay_hours: 0,
              channels: [
                { channel: 'SMS', template_id: id, variable_map: { NAME: 'customer_first_name' } },
              ],
            },
          ],
        }),
      }),
    );
  });

  it('loads SMS templates and their named variables from the scoped builder RPC', async () => {
    const data = {
      can_manage: true,
      tokens: ['customer_first_name'],
      sources: ['Other'],
      channels: { WHATSAPP: false, SMS: true, EMAIL: true },
      templates: [
        {
          id,
          name: 'Thank-you',
          channel: 'SMS',
          status: 'DRAFT',
          body: 'Thanks {{NAME}}',
          placeholders: ['NAME'],
        },
      ],
    };
    rpc.mockResolvedValue({ data, error: null });
    await expect(fetchMarketingDripBuilderOptions()).resolves.toEqual(data);
  });
});
