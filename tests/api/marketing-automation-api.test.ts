import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ rpc }) }));
import {
  fetchMarketingAutomationWorkspace,
  fetchMarketingReviewCustomerOptions,
  createSmsFallbackCampaign,
  fetchMarketingDripBuilderOptions,
  fetchMarketingDripCampaign,
  saveMarketingDripCampaign,
  setMarketingDripStatus,
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
        safe_error_code: null,
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

  const detail = {
    id,
    name: 'SMS thank-you',
    description: null,
    branch_id: id,
    status: 'PAUSED' as const,
    version: 4,
    trigger_type: 'LEAD_CREATED' as const,
    trigger_conditions: { sources: ['Other'], models: ['Sedan'], email_presence: 'MISSING' },
    audience_filter: { provider_tag: 'preserve' },
    steps: [
      {
        step_order: 1,
        delay_hours: 0,
        channels: [
          {
            channel: 'SMS' as const,
            template_id: id,
            variable_map: { NAME: 'customer_first_name' },
            body: 'Thanks {{NAME}}',
          },
        ],
      },
    ],
  };

  it('loads full campaign rules and legacy nullable template identifiers without dropping fields', async () => {
    const data = {
      ...detail,
      trigger_type: 'AUDIENCE',
      steps: [
        { ...detail.steps[0], channels: [{ ...detail.steps[0].channels[0], template_id: null }] },
      ],
    };
    rpc.mockResolvedValue({ data, error: null });
    await expect(fetchMarketingDripCampaign(id)).resolves.toEqual(data);
    expect(rpc).toHaveBeenCalledWith('get_marketing_drip_campaign', { target_campaign_id: id });
  });

  it.each(['LEAD_CREATED', 'AUDIENCE'] as const)(
    'saves %s edits with version, original rules and channel variables',
    async (trigger_type) => {
      rpc.mockResolvedValue({
        data: { id, status: 'PAUSED', version: 5, replayed: false },
        error: null,
      });
      await saveMarketingDripCampaign({ ...detail, trigger_type }, id);
      expect(rpc).toHaveBeenCalledWith(
        trigger_type === 'AUDIENCE'
          ? 'update_marketing_audience_drip_campaign'
          : 'save_marketing_drip_campaign',
        {
          target_campaign_id: id,
          target_expected_version: 4,
          target_branch_id: id,
          target_request_id: id,
          target_payload: {
            name: detail.name,
            description: null,
            trigger_type,
            trigger_conditions: detail.trigger_conditions,
            audience_filter: detail.audience_filter,
            steps: detail.steps,
          },
        },
      );
    },
  );

  it('creates a new event campaign through the same RPC with no id or version', async () => {
    rpc.mockResolvedValue({
      data: { id, status: 'DRAFT', version: 1, replayed: false },
      error: null,
    });
    await saveMarketingDripCampaign({ ...detail, trigger_type: 'BOOKING_CONFIRMED' }, id, true);
    expect(rpc).toHaveBeenCalledWith(
      'save_marketing_drip_campaign',
      expect.objectContaining({
        target_campaign_id: null,
        target_expected_version: null,
        target_branch_id: id,
        target_payload: expect.objectContaining({ trigger_type: 'BOOKING_CONFIRMED' }),
      }),
    );
  });

  it('preserves stale-edit errors and requires the expected version when pausing', async () => {
    const error = { code: 'PT409', message: 'MARKETING_DRIP_CAMPAIGN_VERSION_CONFLICT' };
    rpc.mockResolvedValue({ data: null, error });
    await expect(saveMarketingDripCampaign(detail, id)).rejects.toEqual(error);
    await expect(setMarketingDripStatus(id, 'PAUSED', 4)).rejects.toEqual(error);
    expect(rpc).toHaveBeenLastCalledWith('set_marketing_drip_campaign_status', {
      target_campaign_id: id,
      target_status: 'PAUSED',
      target_expected_version: 4,
    });
  });
});
