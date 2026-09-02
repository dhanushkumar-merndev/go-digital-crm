/**
 * The accent palette the front-line dashboards paint with.
 *
 * Sales Consultant and Telecaller are the same surface for two roles, so their
 * icon chips, soft attention tiles and tile borders have to be the same colours
 * at the same weights. Keeping one table here is what stops the two pages from
 * drifting apart the next time a tone is added or a shade is nudged.
 */
export type Tone = 'blue' | 'rose' | 'amber' | 'emerald' | 'cyan' | 'violet' | 'orange';

export const toneStyles: Record<Tone, { icon: string; soft: string; border: string }> = {
  blue: { icon: 'bg-blue-50 text-blue-600', soft: 'bg-blue-50/70', border: 'border-blue-100' },
  rose: { icon: 'bg-rose-50 text-rose-600', soft: 'bg-rose-50/70', border: 'border-rose-100' },
  amber: { icon: 'bg-amber-50 text-amber-600', soft: 'bg-amber-50/70', border: 'border-amber-100' },
  emerald: {
    icon: 'bg-emerald-50 text-emerald-600',
    soft: 'bg-emerald-50/70',
    border: 'border-emerald-100',
  },
  cyan: { icon: 'bg-cyan-50 text-cyan-600', soft: 'bg-cyan-50/70', border: 'border-cyan-100' },
  violet: {
    icon: 'bg-violet-50 text-violet-600',
    soft: 'bg-violet-50/70',
    border: 'border-violet-100',
  },
  orange: {
    icon: 'bg-orange-50 text-orange-600',
    soft: 'bg-orange-50/70',
    border: 'border-orange-100',
  },
};
