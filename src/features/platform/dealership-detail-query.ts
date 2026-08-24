import { z } from 'zod';

export const platformDealershipActivitySchema = z.object({
  id: z
    .union([z.string().min(1), z.number().int().nonnegative()])
    .transform((value) => String(value)),
  action: z.string(),
  resource_type: z.string(),
  summary: z.string().nullable(),
  created_at: z.string(),
});
