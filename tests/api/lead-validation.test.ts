import { describe, expect, it } from 'vitest';
import { incomingLeadSchema, normalizePhone } from '../../src/lib/validation/lead';

const valid = {
  organization_id: '1f4efeb1-79f2-4ea3-907d-a2b6c7fc59bb',
  branch_id: 'e6810394-e335-4f7f-8fbf-26684da77caf',
  source: 'Website',
  customer_name: 'Aarav Sharma',
  phone: '98731 00001',
};

describe('canonical lead ingestion boundary', () => {
  it('accepts the documented minimum fields', () =>
    expect(incomingLeadSchema.safeParse(valid).success).toBe(true));
  it('rejects an unknown source', () =>
    expect(incomingLeadSchema.safeParse({ ...valid, source: 'Unknown Network' }).success).toBe(
      false,
    ));
  it('normalizes a local Indian phone without using it as an ID', () =>
    expect(normalizePhone('09873 100 001')).toBe('+919873100001'));
});
