import { ChevronRight, Plus } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { Breadcrumb, PageSpec } from '@/lib/domain';
import { cn } from '@/lib/utils';

/**
 * The one page title. Every role's pages open the same way: a breadcrumb that
 * matches the sidebar (Dashboard › group › page), the title the sidebar shows,
 * one line of context, and the page's actions on the right. Pages used to
 * hand-roll this in seven styles with the action button pushed down by
 * `sm:mt-7` beside it; the `actions` slot is where those buttons go now.
 *
 * It carries no outer margin: `PageShell` spaces it like every other section.
 */
export function PageHeader({
  spec,
  title,
  description,
  breadcrumbs,
  meta,
  actions,
  className,
  primaryActionHref,
  onPrimaryAction,
}: {
  spec?: PageSpec;
  /** Overrides the sidebar title. Keep it equal to the sidebar label. */
  title?: string;
  description?: ReactNode;
  breadcrumbs?: Breadcrumb[];
  /** Badges or status shown beside the title. */
  meta?: ReactNode;
  /** Buttons, pickers or menus for the right side. */
  actions?: ReactNode;
  className?: string;
  primaryActionHref?: string;
  onPrimaryAction?: () => void;
}) {
  const crumbs = breadcrumbs ?? spec?.breadcrumbs ?? [];
  const heading = title ?? spec?.title ?? '';
  const context = description ?? spec?.description;
  const primary =
    spec?.primaryAction && primaryActionHref ? (
      <Button className="shrink-0" asChild>
        <Link href={primaryActionHref}>
          <Plus className="size-4" />
          {spec.primaryAction}
        </Link>
      </Button>
    ) : spec?.primaryAction && onPrimaryAction ? (
      <Button type="button" className="shrink-0" onClick={onPrimaryAction}>
        <Plus className="size-4" />
        {spec.primaryAction}
      </Button>
    ) : null;
  return (
    <div className={cn('flex flex-col justify-between gap-4 sm:flex-row sm:items-end', className)}>
      <div className="min-w-0">
        {crumbs.length ? (
          <nav aria-label="Breadcrumb" className="mb-2">
            <ol className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
              {crumbs.map((crumb, index) => (
                <li key={`${crumb.label}-${index}`} className="flex items-center gap-1">
                  {index > 0 ? <ChevronRight className="size-3" aria-hidden /> : null}
                  {crumb.href ? (
                    <Link href={crumb.href} className="text-primary hover:underline">
                      {crumb.label}
                    </Link>
                  ) : (
                    <span aria-current={index === crumbs.length - 1 ? 'page' : undefined}>
                      {crumb.label}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </nav>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-heading text-2xl font-bold tracking-tight md:text-[28px]">
            {heading}
          </h1>
          {spec?.readOnly ? <Badge variant="outline">Read only</Badge> : null}
          {meta}
        </div>
        {context ? (
          <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">{context}</p>
        ) : null}
      </div>
      {actions || primary ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {actions}
          {primary}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The page body every workspace sits in. The shell already caps the width, so
 * pages no longer pick their own 1400–1800px maximum or their own spacing.
 */
export function PageShell({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('mx-auto w-full space-y-5', className)}>{children}</div>;
}
