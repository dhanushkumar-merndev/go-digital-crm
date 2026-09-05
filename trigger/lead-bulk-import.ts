import { createClient } from '@supabase/supabase-js';
import { task } from '@trigger.dev/sdk';

type Payload = { importId: string };

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_MISSING`);
  return value;
}

export const leadBulkImport = task({
  id: 'lead-bulk-import',
  queue: { concurrencyLimit: 2 },
  retry: {
    maxAttempts: 5,
    factor: 2,
    minTimeoutInMs: 1_000,
    maxTimeoutInMs: 30_000,
    randomize: true,
  },
  run: async (payload: Payload) => {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        payload.importId,
      )
    )
      throw new Error('LEAD_BULK_IMPORT_ID_INVALID');
    const supabase = createClient(
      requiredEnvironment('SUPABASE_URL'),
      requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    try {
      const { data, error } = await supabase.rpc('process_lead_bulk_import', {
        target_import_id: payload.importId,
      });
      if (error) throw error;
      return data;
    } catch (error) {
      const { error: retryError } = await supabase.rpc('retry_lead_bulk_import', {
        target_import_id: payload.importId,
        target_safe_error_code: 'BULK_IMPORT_PROCESSING_RETRY',
      });
      if (retryError) throw retryError;
      throw error;
    }
  },
});
