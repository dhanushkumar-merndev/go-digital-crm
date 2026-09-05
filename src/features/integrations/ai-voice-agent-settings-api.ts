import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';

const settingsSchema = z.object({
  agents: z.array(
    z.object({
      id: z.uuid(),
      branch_id: z.uuid(),
      team_id: z.uuid(),
      assigned_user_id: z.uuid(),
      name: z.string(),
      external_agent_id: z.string(),
      language: z.string(),
      prompt_instructions: z.string(),
      auto_call_enabled: z.boolean(),
      delay_seconds: z.coerce.number().int(),
      credit_cost: z.coerce.number().int().positive(),
    }),
  ),
  branches: z.array(z.object({ id: z.uuid(), name: z.string() })),
  teams: z.array(z.object({ id: z.uuid(), branch_id: z.uuid(), name: z.string() })),
  telecallers: z.array(z.object({ id: z.uuid(), team_id: z.uuid(), full_name: z.string() })),
});

export type AiVoiceAgentSettings = z.infer<typeof settingsSchema>;
export type AiVoiceAgent = AiVoiceAgentSettings['agents'][number];

export async function fetchAiVoiceAgentSettings(signal?: AbortSignal) {
  const request = createClient().rpc('get_ai_voice_agent_settings');
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return settingsSchema.parse(data);
}

export async function saveAiVoiceAgent(input: {
  id?: string;
  branchId: string;
  teamId: string;
  assignedUserId: string;
  name: string;
  externalAgentId: string;
  language: string;
  promptInstructions: string;
  autoCallEnabled: boolean;
  creditCost: number;
}) {
  const { data, error } = await createClient().rpc('upsert_ai_voice_agent', {
    target_id: input.id ?? null,
    target_branch_id: input.branchId,
    target_team_id: input.teamId,
    target_assigned_user_id: input.assignedUserId,
    target_name: input.name,
    target_external_agent_id: input.externalAgentId,
    target_language: input.language,
    target_prompt_instructions: input.promptInstructions,
    target_auto_call_enabled: input.autoCallEnabled,
    target_credit_cost: input.creditCost,
  });
  if (error) throw error;
  return z.uuid().parse(data);
}
