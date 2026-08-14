import { z } from 'zod';

export const canonicalLeadSourceSchema = z.enum([
  'Facebook',
  'Instagram',
  'Google Ads',
  'Website',
  'WhatsApp Business',
  'CarWale',
  'CarDekho',
  'Justdial',
  'IndiaMART',
  'Manual',
  'Other',
]);

export const incomingLeadSchema = z.object({
  organization_id: z.uuid(),
  branch_id: z.uuid(),
  team_id: z.uuid().optional(),
  connection_id: z.uuid().optional(),
  external_lead_id: z.string().trim().min(1).max(250).optional(),
  source: canonicalLeadSourceSchema,
  source_detail: z.string().trim().max(200).optional(),
  campaign: z.string().trim().max(200).optional(),
  customer_name: z.string().trim().min(2).max(160),
  phone: z.string().trim().min(7).max(24),
  email: z.email().optional(),
  interested_model: z.string().trim().max(160).optional(),
});

export function normalizePhone(phone: string) {
  const normalized = phone.replace(/[^\d+]/g, '');
  return normalized.startsWith('+') ? normalized : `+91${normalized.replace(/^0+/, '')}`;
}
