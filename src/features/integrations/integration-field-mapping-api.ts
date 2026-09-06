import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

const mappingSchema = z.object({
  id: z.uuid(),
  external_field: z.string(),
  canonical_field: z.string(),
  transform_config: z.record(z.string(), z.unknown()),
});
const viewSchema = z.object({
  connection_id: z.uuid(),
  provider_key: z.string(),
  /** Exactly what CanonicalLeadInput accepts, so the picker cannot offer a
   * target that ingestion would silently drop. */
  canonical_fields: z.array(z.string()),
  mappings: z.array(mappingSchema),
});

export type IntegrationFieldMapping = z.infer<typeof mappingSchema>;
export type IntegrationFieldMappingView = z.infer<typeof viewSchema>;
export const integrationFieldMappingKey = (connectionId: string) =>
  ['integration-field-mappings', connectionId] as const;

export async function fetchIntegrationFieldMappings(connectionId: string, signal?: AbortSignal) {
  const request = createClient().rpc('get_integration_field_mappings', {
    target_connection_id: connectionId,
  });
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return viewSchema.parse(data);
}

/** Saved as a complete set: a half-applied mapping would land ads columns in
 * the wrong CRM fields during ingestion. */
export async function saveIntegrationFieldMappings(input: {
  connectionId: string;
  mappings: Array<{
    external_field: string;
    canonical_field: string;
    transform_config?: Record<string, unknown>;
  }>;
}) {
  const { data, error } = await createClient().rpc('save_integration_field_mappings', {
    target_connection_id: input.connectionId,
    target_mappings: input.mappings,
    target_request_id: globalThis.crypto.randomUUID(),
  });
  if (error) throw error;
  return z
    .object({ connection_id: z.uuid(), mapping_count: z.coerce.number().int().nonnegative() })
    .parse(data);
}

export function getFieldMappingErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (message.includes('DUPLICATE_EXTERNAL_FIELD'))
    return 'Two rules point at the same ads column. Give each column one target field.';
  if (message.includes('INVALID_FIELD_MAPPING_ENTRY'))
    return 'Every row needs an ads column name and a CRM field this system can ingest.';
  if (message.includes('INTEGRATION_SCOPE_DENIED'))
    return 'This connection is mapped to branches outside your scope.';
  if (message.includes('INTEGRATION_MANAGE_PERMISSION_REQUIRED'))
    return 'You are not allowed to change integration field mappings.';
  return 'The field mapping could not be saved. Try again in a moment.';
}
