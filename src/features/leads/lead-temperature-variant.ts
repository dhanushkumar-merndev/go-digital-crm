import type { BadgeVariant } from '@/components/ui/badge';

/**
 * The one mapping from a lead's temperature to a badge colour (AGENTS.md 9.7).
 * Temperature is its own axis and never shares the stage scale. DORMANT is
 * do-not-disturb, not a colder COLD, so it must not share the COLD styling:
 * someone scanning the column has to see that the lead is suppressed from
 * outbound messaging.
 */
export function leadTemperatureVariant(temperature: string | null | undefined): BadgeVariant {
  if (temperature === 'HOT') return 'destructive';
  if (temperature === 'WARM') return 'warning';
  if (temperature === 'DORMANT') return 'secondary';
  return 'info';
}
