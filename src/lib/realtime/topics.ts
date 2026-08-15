export type TenantRealtimeResource =
  | 'leads'
  | 'customers'
  | 'communications'
  | 'work'
  | 'notifications'
  | 'integrations'
  | 'support'
  | 'administration'
  | 'sales'
  | 'inventory'
  | 'operations'
  | 'customer-care'
  | 'marketing';

export type PlatformRealtimeResource =
  'dealerships' | 'onboarding' | 'support' | 'health' | 'retention' | 'integrations';

export function tenantRealtimeTopic(organizationId: string, resource: TenantRealtimeResource) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      organizationId,
    )
  )
    throw new Error('INVALID_REALTIME_ORGANIZATION');
  return `organization:${organizationId}:${resource}`;
}

export function platformRealtimeTopic(resource: PlatformRealtimeResource) {
  return `platform:${resource}`;
}
