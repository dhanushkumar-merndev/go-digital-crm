import Link from 'next/link';
import { TrendingDown, TrendingUp } from 'lucide-react';
import type { ComponentType } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { toneStyles, type Tone } from '@/features/dashboards/dashboard-tone';
import { cn } from '@/lib/utils';

export type MetricCardProps = {
  label: string;
  value: string | number;
  icon?: ComponentType<{ className?: string }>;
  /** A named accent, or raw Tailwind classes for the icon chip. */
  tone?: Tone | string;
  /** What the number means. Shown when there is no trend behind it. */
  caption?: string;
  /** A signed move, e.g. "+12%", with the direction it should be read in. */
  change?: string;
  trend?: 'up' | 'down' | 'neutral';
  href?: string;
  className?: string;
};

function chipClass(tone: MetricCardProps['tone']) {
  if (!tone) return toneStyles.blue.icon;
  return tone in toneStyles ? toneStyles[tone as Tone].icon : tone;
}

/**
 * The KPI tile every workspace shares: a small icon chip beside the label, the
 * value centred underneath, and one line saying what it means. This is the
 * Telecaller and Sales Consultant tile, lifted out so the other roles read the
 * same way. Clickable when it has a destination.
 */
export function MetricCard({
  label,
  value,
  icon: Icon,
  tone,
  caption,
  change,
  trend = 'neutral',
  href,
  className,
}: MetricCardProps) {
  const TrendIcon = trend === 'down' ? TrendingDown : TrendingUp;
  const card = (
    <Card
      className={cn(
        'h-full min-w-0 border-slate-200/90 shadow-none',
        href &&
          'transition-all group-hover:-translate-y-0.5 group-hover:border-blue-200 group-hover:shadow-sm',
        className,
      )}
    >
      <CardContent className="p-4">
        <div className="flex items-center gap-2.5">
          {Icon ? (
            <span
              className={cn('grid size-8 shrink-0 place-items-center rounded-lg', chipClass(tone))}
            >
              <Icon className="size-4" />
            </span>
          ) : null}
          <p className="min-w-0 text-[11px] font-semibold leading-4 text-[#263550]">{label}</p>
        </div>
        <p className="mt-3 text-center text-[26px] font-bold leading-none tracking-tight text-[#12213f]">
          {value}
        </p>
        {change ? (
          <p
            className={cn(
              'mt-3 flex flex-wrap items-center justify-center gap-1 text-[10px] font-semibold',
              trend === 'down'
                ? 'text-rose-600'
                : trend === 'up'
                  ? 'text-emerald-600'
                  : 'text-muted-foreground',
            )}
          >
            <TrendIcon className="size-3" /> {change}
            {caption ? <span className="font-normal text-muted-foreground">{caption}</span> : null}
          </p>
        ) : (
          <p className="mt-3 text-center text-[10px] font-normal text-muted-foreground">
            {caption ?? ' '}
          </p>
        )}
      </CardContent>
    </Card>
  );
  return href ? (
    <Link
      href={href}
      className="group min-w-0 rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      {card}
    </Link>
  ) : (
    card
  );
}
