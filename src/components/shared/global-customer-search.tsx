'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, LoaderCircle, Search, UserRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  hasWorkspacePermission,
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import type { RoleKey } from '@/config/navigation/types';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import {
  globalCustomerSearchKey,
  searchAuthorizedCustomers,
} from '@/features/customers/global-customer-search-api';
import { useRouter } from 'next/navigation';

function CustomerSearchDialog({
  open,
  onOpenChange,
  role,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  role: RoleKey;
}) {
  const router = useRouter();
  const workspaceSession = useWorkspaceSession();
  const [value, setValue] = useState('');
  const [page, setPage] = useState(1);
  const query = useDebouncedValue(value, 300);
  const normalizedSearch = query.normalize('NFKC').trim();
  const ready = normalizedSearch.length >= 2;

  useEffect(() => setPage(1), [normalizedSearch]);
  useEffect(() => {
    if (open) return;
    setValue('');
    setPage(1);
  }, [open]);

  const results = useQuery({
    queryKey: [
      ...globalCustomerSearchKey,
      ...workspaceQueryScope(workspaceSession),
      normalizedSearch,
      page,
    ],
    queryFn: ({ signal }) => searchAuthorizedCustomers({ search: normalizedSearch, page, signal }),
    enabled: open && ready,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });

  const openCustomer = (customerId: string) => {
    onOpenChange(false);
    router.push(`/${role}/customers/${customerId}`);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] max-w-2xl overflow-y-auto p-0">
        <DialogHeader className="border-b px-5 py-4 pr-12">
          <DialogTitle>Customer search</DialogTitle>
          <DialogDescription>
            Search only customers you are authorized to access by name, mobile, email, or ID.
          </DialogDescription>
        </DialogHeader>
        <div className="p-5">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              value={value}
              onChange={(event) => setValue(event.target.value)}
              className="h-10 pl-9"
              placeholder="Customer name, mobile, email, or customer ID"
              aria-label="Search authorized customers"
            />
            {results.isFetching ? (
              <LoaderCircle className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
            ) : null}
          </div>
          {!ready ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              Enter at least two characters to search your authorized customer records.
            </p>
          ) : results.isError ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              Customer search is unavailable right now. Try again in a moment.
            </p>
          ) : results.data?.records.length ? (
            <div className="mt-4 overflow-hidden rounded-lg border">
              {results.data.records.map((record) => (
                <button
                  key={record.id}
                  type="button"
                  className="flex w-full items-center gap-3 border-b px-4 py-3 text-left last:border-b-0 hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:outline-none"
                  onClick={() => openCustomer(record.id)}
                >
                  <span className="grid size-9 shrink-0 place-items-center rounded-full bg-blue-50 text-blue-700">
                    <UserRound className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-[#17233d]">
                      {record.full_name}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                      {[record.primary_phone, record.primary_email].filter(Boolean).join(' · ') ||
                        'No primary contact'}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          ) : results.isPending ? (
            <div className="space-y-2 py-5" aria-label="Searching customers">
              <div className="h-14 animate-pulse rounded-md bg-slate-100" />
              <div className="h-14 animate-pulse rounded-md bg-slate-100" />
            </div>
          ) : (
            <p className="py-10 text-center text-sm text-muted-foreground">
              No authorized customers match this search.
            </p>
          )}
          {ready && results.data ? (
            <div className="mt-4 flex items-center justify-between border-t pt-4">
              <Button
                variant="outline"
                size="sm"
                disabled={page === 1 || results.isFetching}
                onClick={() => setPage((current) => current - 1)}
              >
                <ChevronLeft className="size-4" /> Previous
              </Button>
              <span className="text-xs text-muted-foreground">Page {page}</span>
              <Button
                variant="outline"
                size="sm"
                disabled={!results.data.has_next || results.isFetching}
                onClick={() => setPage((current) => current + 1)}
              >
                Next <ChevronRight className="size-4" />
              </Button>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function GlobalCustomerSearch({ role }: { role: RoleKey }) {
  const workspaceSession = useWorkspaceSession();
  const [open, setOpen] = useState(false);
  const canSearch =
    Boolean(workspaceSession?.organizationId) &&
    hasWorkspacePermission(workspaceSession, 'customer.view');

  useEffect(() => {
    if (!canSearch) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [canSearch]);

  if (!canSearch) return null;

  return (
    <>
      <Button
        variant="outline"
        className="hidden h-9 w-full max-w-[360px] justify-start gap-2 bg-slate-50 px-3 text-xs font-normal text-muted-foreground md:flex"
        onClick={() => setOpen(true)}
        aria-label="Search customers"
      >
        <Search className="size-4" />
        <span className="flex-1 text-left">Search customers</span>
        <kbd className="rounded border bg-white px-1.5 py-0.5 text-[9px] text-muted-foreground">
          ⌘ K
        </kbd>
      </Button>
      <CustomerSearchDialog open={open} onOpenChange={setOpen} role={role} />
    </>
  );
}
