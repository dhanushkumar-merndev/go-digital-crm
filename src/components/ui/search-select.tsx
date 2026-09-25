'use client';

import * as PopoverPrimitive from '@radix-ui/react-popover';
import { Check, ChevronDown, LoaderCircle, Search } from 'lucide-react';
import * as React from 'react';
import { cn } from '@/lib/utils';

export type SearchSelectOption = {
  value: string;
  label: string;
  /** Secondary line rendered under the label, e.g. phone · model. */
  description?: string;
};

/**
 * One control for "search a server-backed list, then pick one row".
 *
 * The pattern this replaces was a free Input next to a plain Select: two
 * controls for one decision, with three failure modes the Select could not
 * express. An empty result set rendered an empty popup with no explanation; a
 * refetch under a new search term emptied the list while it was open, because
 * every search term is its own query key; and the chosen row silently vanished
 * from `data` the moment the search changed, which read downstream as "the
 * selected customer is no longer available".
 *
 * The last of those is why the component keeps its own copy of the option that
 * was actually chosen: selection is a decision the user already made, and it
 * must not depend on whether that row is still in the current search page.
 */
export function SearchSelect({
  value,
  onValueChange,
  options,
  search,
  onSearchChange,
  isPending = false,
  isFetching = false,
  isError = false,
  disabled = false,
  placeholder = 'Select an option',
  searchPlaceholder = 'Search…',
  emptyMessage = 'No matches found.',
  errorMessage = 'This list could not be loaded. Try again in a moment.',
  disabledMessage,
  hasMore = false,
  onLoadMore,
  isLoadingMore = false,
  className,
  id,
  'aria-label': ariaLabel,
  'aria-describedby': ariaDescribedBy,
  'aria-invalid': ariaInvalid,
}: {
  value: string;
  onValueChange: (value: string, option: SearchSelectOption) => void;
  options: SearchSelectOption[] | undefined;
  search: string;
  onSearchChange: (search: string) => void;
  isPending?: boolean;
  isFetching?: boolean;
  isError?: boolean;
  disabled?: boolean;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  errorMessage?: string;
  /** Shown on the trigger instead of `placeholder` while `disabled`. */
  disabledMessage?: string;
  /** The server has another page beyond the rows shown; renders "See more". */
  hasMore?: boolean;
  onLoadMore?: () => void;
  isLoadingMore?: boolean;
  className?: string;
  id?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [highlighted, setHighlighted] = React.useState(0);
  const [chosen, setChosen] = React.useState<SearchSelectOption | null>(null);
  const listId = React.useId();
  const searchRef = React.useRef<HTMLInputElement>(null);
  const optionRefs = React.useRef(new Map<string, HTMLDivElement>());

  const items = React.useMemo(() => options ?? [], [options]);

  // The freshest copy of the chosen row wins, so a rename in another tab is
  // picked up; the retained copy only covers the row falling out of the page.
  const selected = React.useMemo(
    () => items.find((item) => item.value === value) ?? (chosen?.value === value ? chosen : null),
    [items, value, chosen],
  );

  // Opening starts the keyboard cursor on the current selection. This is the
  // documented "adjust state when a prop changes" pattern rather than an
  // effect, so no extra render pass is scheduled just to move a highlight.
  const [wasOpen, setWasOpen] = React.useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      const index = items.findIndex((item) => item.value === value);
      setHighlighted(index >= 0 ? index : 0);
    }
  }

  // Clamped on read: a narrower search can shrink the list under the cursor,
  // and a stored index would then point past the end.
  const activeIndex = items.length ? Math.min(highlighted, items.length - 1) : 0;

  React.useEffect(() => {
    if (!open) return;
    const active = items[activeIndex];
    if (active) optionRefs.current.get(active.value)?.scrollIntoView({ block: 'nearest' });
  }, [open, items, activeIndex]);

  const commit = (option: SearchSelectOption) => {
    setChosen(option);
    onValueChange(option.value, option);
    setOpen(false);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!items.length) return;
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      setHighlighted((activeIndex + delta + items.length) % items.length);
      return;
    }
    if (event.key === 'Enter') {
      const option = items[activeIndex];
      if (option) {
        event.preventDefault();
        commit(option);
      }
    }
  };

  return (
    <PopoverPrimitive.Root open={open && !disabled} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger
        id={id}
        type="button"
        disabled={disabled}
        role="combobox"
        aria-expanded={open}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
        className={cn(
          'flex h-10 w-full items-center justify-between gap-2 rounded-lg border border-input bg-background px-3 py-2 text-left text-sm outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
      >
        <span className={cn('min-w-0 flex-1 truncate', !selected && 'text-muted-foreground')}>
          {selected ? selected.label : disabled ? (disabledMessage ?? placeholder) : placeholder}
        </span>
        {isFetching ? (
          <LoaderCircle className="size-4 shrink-0 animate-spin opacity-60" />
        ) : (
          <ChevronDown className="size-4 shrink-0 opacity-60" />
        )}
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={4}
          className="z-50 w-[--radix-popover-trigger-width] overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-md"
          onOpenAutoFocus={(event) => {
            // Focus belongs in the search box, not on the first row: the list is
            // server-filtered, so typing is the primary way to reach an option.
            event.preventDefault();
            searchRef.current?.focus();
          }}
        >
          <div className="relative border-b">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              ref={searchRef}
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              aria-controls={listId}
              autoComplete="off"
              spellCheck={false}
              className="h-10 w-full bg-transparent pl-9 pr-9 text-sm outline-none placeholder:text-muted-foreground"
            />
            {isFetching ? (
              <LoaderCircle className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
            ) : null}
          </div>
          {/* Five rows, then scroll. A row with a description is 54px (py-2 plus
              a 20px label, 2px gap and a 16px description line), so five is
              270px inside the 8px of container padding. The old max-h-64 (256px)
              cut the fifth row in half; the extra 2px here keeps a sliver of the
              sixth visible so it reads as scrollable rather than complete. */}
          <div id={listId} role="listbox" className="max-h-[17.5rem] overflow-y-auto p-1">
            {isError ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">{errorMessage}</p>
            ) : isPending ? (
              <div className="space-y-1 p-1" aria-label="Loading options">
                <div className="h-9 animate-pulse rounded-md bg-muted" />
                <div className="h-9 animate-pulse rounded-md bg-muted" />
                <div className="h-9 animate-pulse rounded-md bg-muted" />
              </div>
            ) : items.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">{emptyMessage}</p>
            ) : (
              items.map((option, index) => (
                <div
                  key={option.value}
                  ref={(node) => {
                    if (node) optionRefs.current.set(option.value, node);
                    else optionRefs.current.delete(option.value);
                  }}
                  role="option"
                  tabIndex={-1}
                  aria-selected={option.value === value}
                  onMouseEnter={() => setHighlighted(index)}
                  onClick={() => commit(option)}
                  className={cn(
                    'flex cursor-pointer items-start gap-2 rounded-md px-2 py-2 text-sm',
                    index === activeIndex && 'bg-muted',
                  )}
                >
                  <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
                    {option.value === value ? <Check className="size-4" /> : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{option.label}</span>
                    {option.description ? (
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                        {option.description}
                      </span>
                    ) : null}
                  </span>
                </div>
              ))
            )}
            {/* Pages are small (five rows) so the first open is one cheap query;
                further rows are fetched only when the user asks for them. */}
            {!isError && !isPending && items.length > 0 && hasMore && onLoadMore ? (
              <button
                type="button"
                onClick={onLoadMore}
                disabled={isLoadingMore}
                className="mt-1 flex w-full items-center justify-center gap-2 rounded-md px-2 py-2 text-sm font-medium text-primary hover:bg-muted disabled:opacity-60"
              >
                {isLoadingMore ? <LoaderCircle className="size-4 animate-spin" /> : null}
                {isLoadingMore ? 'Loading…' : 'See more'}
              </button>
            ) : null}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
