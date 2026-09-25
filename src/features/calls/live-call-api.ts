import { createClient } from '@/lib/supabase/client';
import { liveCallSchema, type LiveCall } from './live-call-status';

export {
  isLiveCallStatus,
  liveCallStatuses,
  liveCallQueryKeyRoot,
  normalizeLiveCallStatus,
  type LiveCall,
  type LiveCallStatus,
} from './live-call-status';

export async function fetchActiveCall(signal?: AbortSignal): Promise<LiveCall | null> {
  const request = createClient().rpc('get_active_call_status');
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  if (!data) return null;
  return liveCallSchema.parse(data);
}
