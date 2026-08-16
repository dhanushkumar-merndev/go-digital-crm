import { cacheFingerprint } from './workspace-cache.ts';

const base = {
  resource: 'tenant-dashboard',
  organization_id: '11111111-1111-4111-8111-111111111111',
  role: 'team-manager',
  scope: { kind: 'OWN_TEAM', team_ids: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'] },
  capabilities: 'lead.view,call.view',
  filters: { days: 14, timezone: 'Asia/Kolkata' },
  version: 7,
};

Deno.test('workspace cache fingerprint is stable for canonical object order', async () => {
  const reordered = {
    version: 7,
    filters: { timezone: 'Asia/Kolkata', days: 14 },
    capabilities: 'lead.view,call.view',
    scope: { team_ids: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'], kind: 'OWN_TEAM' },
    role: 'team-manager',
    organization_id: '11111111-1111-4111-8111-111111111111',
    resource: 'tenant-dashboard',
  };
  if ((await cacheFingerprint(base)) !== (await cacheFingerprint(reordered))) {
    throw new Error('CANONICAL_FINGERPRINT_MISMATCH');
  }
});

Deno.test(
  'workspace cache fingerprint separates tenant, role, scope, capabilities, filters, and version',
  async () => {
    const baseFingerprint = await cacheFingerprint(base);
    const changes = [
      { ...base, organization_id: '22222222-2222-4222-8222-222222222222' },
      { ...base, role: 'sales-consultant' },
      { ...base, scope: { kind: 'OWN_RECORDS', user_id: '33333333-3333-4333-8333-333333333333' } },
      {
        ...base,
        scope: { kind: 'ONE_BRANCH', branch_ids: ['44444444-4444-4444-8444-444444444444'] },
      },
      { ...base, capabilities: 'lead.view' },
      { ...base, filters: { days: 30, timezone: 'Asia/Kolkata' } },
      { ...base, version: 8 },
    ];
    for (const changed of changes) {
      if ((await cacheFingerprint(changed)) === baseFingerprint) {
        throw new Error('CACHE_FINGERPRINT_COLLISION');
      }
    }
  },
);
