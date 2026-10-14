import { describe, expect, it } from 'vitest';
import { isLeadFlowReadRpc } from '../../scripts/lead-flow-read-rpcs.mjs';

describe('lead flow read-only load safety', () => {
  it('allows the paginated lead read used in the real flow', () => {
    expect(isLeadFlowReadRpc('get_lead_workspace_page_v2')).toBe(true);
  });

  it('allows read-only department and inventory lookups', () => {
    expect(isLeadFlowReadRpc('get_operational_case_workspace_page')).toBe(true);
    expect(isLeadFlowReadRpc('get_stock_unit_page')).toBe(true);
  });

  it('refuses the PDI creation RPC despite its get prefix', () => {
    expect(isLeadFlowReadRpc('get_or_create_pdi_inspection')).toBe(false);
  });

  it('refuses the transactional follow-up handoff', () => {
    expect(isLeadFlowReadRpc('complete_followup')).toBe(false);
  });

  it('refuses an unknown get RPC until it has been reviewed as read-only', () => {
    expect(isLeadFlowReadRpc('get_or_assign_future_lead')).toBe(false);
    expect(isLeadFlowReadRpc('get_future_report')).toBe(false);
  });
});
