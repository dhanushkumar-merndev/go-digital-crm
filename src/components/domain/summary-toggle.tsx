'use client';

import { ChevronDown, ChevronUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * Collapses the KPI card strip above a list page.
 *
 * The cards are a summary, not the work. On a laptop they push the first rows
 * of the table under the fold, and someone working a queue wants the rows. My
 * Leads grew this control first; it lives here so every list page shares one
 * implementation, with one accessible name and one piece of keyboard behaviour,
 * rather than a copy per workspace that drifts.
 *
 * `controls` must be the id of the element being hidden. Hide that element with
 * the `hidden` attribute rather than a display class, so it leaves the
 * accessibility tree and tab order along with the layout.
 */
export function SummaryToggle({
  open,
  onToggle,
  controls,
  label,
}: {
  open: boolean;
  onToggle: () => void;
  controls: string;
  /** Noun for the tooltip and accessible name, e.g. 'lead summary'. */
  label: string;
}) {
  return (
    <div className="flex shrink-0 items-center pl-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="size-7 rounded-full bg-background shadow-none"
            aria-expanded={open}
            aria-controls={controls}
            aria-label={open ? `Hide ${label} cards` : `Show ${label} cards`}
            onClick={onToggle}
          >
            {open ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{open ? `Hide ${label}` : `Show ${label}`}</TooltipContent>
      </Tooltip>
    </div>
  );
}
