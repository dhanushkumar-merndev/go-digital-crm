import { createClient } from '@supabase/supabase-js';
import { schedules } from '@trigger.dev/sdk';

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_MISSING`);
  return value;
}

export const supportSessionExpiry = schedules.task({
  id: 'support-session-expiry',
  cron: '* * * * *',
  run: async () => {
    const supabase = createClient(
      requiredEnvironment('SUPABASE_URL'),
      requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const { data, error } = await supabase.rpc('expire_support_sessions');
    if (error) throw error;
    return { expired_sessions: data ?? 0 };
  },
});
