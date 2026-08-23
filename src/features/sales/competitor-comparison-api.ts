import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';
const ourSchema = z.object({
  id: z.uuid(),
  brand: z.string(),
  model: z.string(),
  variant: z.string(),
  specifications: z.record(z.string(), z.unknown()),
});
const competitorSchema = z.object({
  id: z.uuid(),
  manufacturer: z.string(),
  model: z.string(),
  variant: z.string(),
  fuel_type: z.string().nullable(),
  ex_showroom_price: z.coerce.number().nonnegative().nullable(),
  specifications: z.record(z.string(), z.unknown()),
  advantages: z.array(z.string()),
});
const optionsSchema = z.object({
  our_variants: z.array(ourSchema),
  competitors: z.array(competitorSchema),
});
export type OurComparisonVariant = z.infer<typeof ourSchema>;
export type CompetitorComparisonProfile = z.infer<typeof competitorSchema>;
export async function fetchCompetitorComparisonOptions(signal?: AbortSignal) {
  const request = createClient().rpc('get_sales_competitor_comparison_options');
  const { data, error } = await (signal ? request.abortSignal(signal) : request);
  if (error) throw error;
  return optionsSchema.parse(data);
}
