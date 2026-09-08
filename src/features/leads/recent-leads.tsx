'use client';

import { useEffect } from 'react';
import { create } from 'zustand';
import { History } from 'lucide-react';
import { useRouter } from 'next/navigation';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

type RecentLead = { id: string; name: string; model: string | null };
// Session memory only: customer names are never written to browser storage.
const useRecentLeads = create<{
  scope: string;
  records: RecentLead[];
  visit: (scope: string, lead: RecentLead) => void;
  clear: () => void;
}>((set) => ({
  scope: '',
  records: [],
  visit: (scope, lead) =>
    set((state) => ({
      scope,
      records: [
        lead,
        ...(state.scope === scope ? state.records : []).filter((item) => item.id !== lead.id),
      ].slice(0, 12),
    })),
  clear: () => set({ scope: '', records: [] }),
}));

export function useTrackRecentLead(lead?: {
  id: string;
  customer_name: string;
  interested_model: string | null;
}) {
  const session = useWorkspaceSession();
  const scope = JSON.stringify(workspaceQueryScope(session));
  const visit = useRecentLeads((state) => state.visit);
  const id = lead?.id;
  const name = lead?.customer_name;
  const model = lead?.interested_model;
  useEffect(() => {
    if (session && id && name) visit(scope, { id, name, model: model ?? null });
  }, [session, scope, id, name, model, visit]);
}

export function RecentLeadsMenu({ role }: { role: string }) {
  const router = useRouter();
  const session = useWorkspaceSession();
  const scope = JSON.stringify(workspaceQueryScope(session));
  const state = useRecentLeads();
  const clear = state.clear;
  const records = state.scope === scope && session ? state.records : [];
  useEffect(() => {
    if (!session) clear();
  }, [session, clear]);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" aria-label="Recently viewed leads">
          <History className="size-4" />
          <span className="hidden xl:inline">Recent leads</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>Recently viewed leads</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {records.length ? (
          records.map((lead) => (
            <DropdownMenuItem
              key={lead.id}
              onSelect={() => router.push(`/${role}/leads/${lead.id}`)}
              className="flex flex-col items-start"
            >
              <span className="max-w-full truncate font-medium">{lead.name}</span>
              <span className="max-w-full truncate text-xs text-muted-foreground">
                {lead.model ?? 'Enquiry'} · {lead.id.slice(0, 8)}
              </span>
            </DropdownMenuItem>
          ))
        ) : (
          <p className="p-3 text-sm text-muted-foreground">
            Open a lead to find it here during this session.
          </p>
        )}
        {records.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={state.clear}>Clear recent leads</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
