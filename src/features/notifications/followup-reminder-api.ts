import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';
const reminderSchema = z.object({ id: z.uuid(), due_at: z.string(), reason: z.string() });
export type FollowupReminder = z.infer<typeof reminderSchema>;
export const followupReminderKey = ['followup-reminders'] as const;
export async function fetchFollowupReminders(signal: AbortSignal) {
  const { data, error } = await createClient().rpc('get_my_followup_reminders').abortSignal(signal);
  if (error) throw error;
  const result = z.object({ server_now: z.string(), records: z.array(reminderSchema) }).parse(data);
  return { ...result, receivedAt: Date.now() };
}
export async function claimFollowupReminder(
  item: FollowupReminder,
  phase: 'UPCOMING' | 'DUE',
  signal: AbortSignal,
) {
  const { data, error } = await createClient()
    .rpc('claim_followup_web_reminder', {
      target_followup_id: item.id,
      target_due_at: item.due_at,
      target_phase: phase,
    })
    .abortSignal(signal);
  if (error) throw error;
  return data === true;
}
