'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/client';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const replySchema = z.object({ id: z.uuid(), name: z.string(), body: z.string().min(1).max(1500) });
const pageSchema = z.object({ records: z.array(replySchema) });

export function PersonalWhatsAppTemplatePicker({
  conversationId,
  disabled,
  onUse,
}: {
  conversationId: string;
  disabled: boolean;
  onUse: (body: string) => void;
}) {
  const session = useWorkspaceSession();
  const [search, setSearch] = useState('');
  const debounced = useDebouncedValue(search, 300);
  const [pagination, setPagination] = useState({ search: '', page: 1 });
  const page = pagination.search === debounced ? pagination.page : 1;
  const replies = useQuery({
    queryKey: [
      'personal-whatsapp-templates',
      ...workspaceQueryScope(session),
      conversationId,
      debounced,
      page,
    ],
    queryFn: async ({ signal }) => {
      const { data, error } = await createClient()
        .rpc('get_personal_whatsapp_templates', {
          target_conversation_id: conversationId,
          target_search: debounced,
          target_page: page,
        })
        .abortSignal(AbortSignal.any([signal, AbortSignal.timeout(10_000)]));
      if (error) throw error;
      return pageSchema.parse(data);
    },
    staleTime: 60_000,
    // Covers reconnects and an admin saving in a different browser session.
    refetchInterval: 15_000,
    retry: 1,
    meta: { persist: false },
  });
  return (
    <section className="space-y-3 border-t pt-4">
      <div>
        <p className="text-sm font-semibold">Quick replies</p>
        <p className="text-xs text-muted-foreground">Templates shared by your admin.</p>
      </div>
      <Input
        aria-label="Search quick replies"
        placeholder="Search replies…"
        value={search}
        maxLength={100}
        onChange={(event) => setSearch(event.target.value)}
      />
      {replies.isPending ? (
        <p className="text-xs text-muted-foreground">Loading replies…</p>
      ) : replies.isError ? (
        <div className="text-xs text-muted-foreground">
          Replies are unavailable.
          <Button size="sm" variant="ghost" onClick={() => void replies.refetch()}>
            Retry
          </Button>
        </div>
      ) : replies.data.records.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {debounced
            ? 'No matching replies.'
            : 'No saved replies yet. Ask your Client Admin to create a My WhatsApp template.'}
        </p>
      ) : (
        <div className="max-h-64 space-y-2 overflow-y-auto">
          {replies.data.records.map((reply) => (
            <Button
              key={reply.id}
              variant="outline"
              className="h-auto w-full justify-start whitespace-normal px-3 py-2 text-left"
              disabled={disabled}
              onClick={() => onUse(reply.body)}
            >
              {reply.name}
            </Button>
          ))}
        </div>
      )}
      {(page > 1 || replies.data?.records.length === 25) && (
        <div className="flex items-center justify-between gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={page === 1 || replies.isFetching}
            onClick={() => setPagination({ search: debounced, page: page - 1 })}
          >
            Previous
          </Button>
          <span className="text-xs">{page}</span>
          <Button
            size="sm"
            variant="ghost"
            disabled={replies.isFetching || replies.data?.records.length !== 25}
            onClick={() => setPagination({ search: debounced, page: page + 1 })}
          >
            Next
          </Button>
        </div>
      )}
    </section>
  );
}
