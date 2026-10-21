import { ArrowRight, CircleAlert, Clock3, Info } from 'lucide-react';
import Link from 'next/link';
import { SectionCard } from '@/components/shared/section-card';
import type { PageSpec } from '@/lib/domain';
import { cn } from '@/lib/utils';

type AttentionItem = NonNullable<PageSpec['attention']>[number] & {
  /** Where the item is fixed. Without it the row is information only. */
  href?: string;
};

const severityIcon = { high: CircleAlert, medium: Clock3, low: Info };
const severityTone = {
  high: 'bg-red-50 text-red-600',
  medium: 'bg-amber-50 text-amber-600',
  low: 'bg-blue-50 text-blue-600',
};

/**
 * Actionable exceptions above the history (AGENTS.md 52.1 §6). Each row opens
 * the page that resolves it; a page with nothing pending says so rather than
 * hiding the card, so an empty list reads as "all clear", not "not loaded".
 */
export function AttentionList({
  items,
  title = 'Requires attention',
  className,
}: {
  items: AttentionItem[];
  title?: string;
  className?: string;
}) {
  return (
    <SectionCard title={title} className={className} contentClassName="space-y-2">
      {items.length ? (
        items.map((item) => {
          const Icon = severityIcon[item.severity];
          const body = (
            <>
              <span
                className={cn(
                  'mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg',
                  severityTone[item.severity],
                )}
              >
                <Icon className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-heading">{item.title}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{item.detail}</span>
              </span>
              {item.href ? (
                <ArrowRight className="mt-2 size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
              ) : null}
            </>
          );
          return item.href ? (
            <Link
              key={item.title}
              href={item.href}
              className="group flex w-full items-start gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/50"
            >
              {body}
            </Link>
          ) : (
            <div key={item.title} className="flex w-full items-start gap-3 rounded-lg border p-3">
              {body}
            </div>
          );
        })
      ) : (
        <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
          Nothing needs attention right now.
        </p>
      )}
    </SectionCard>
  );
}
