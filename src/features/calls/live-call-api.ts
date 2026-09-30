import { createClient } from '@/lib/supabase/client';
import { readRpc } from '@/lib/supabase/read-rpc';
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
  const data = await readRpc(request, signal);
  if (!data) return null;
  return liveCallSchema.parse(data);
}
