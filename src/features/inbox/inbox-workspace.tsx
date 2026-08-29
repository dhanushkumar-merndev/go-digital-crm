'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import {
  ChevronLeft,
  LoaderCircle,
  MessageCircleMore,
  RefreshCw,
  Search,
  Send,
  UserRound,
} from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { InboxSkeleton } from '@/components/skeletons/sales-consultant-skeletons';
import {
  hasWorkspacePermission,
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { useSalesConsultantCache } from '@/features/sales-consultant/sales-consultant-cache';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useTenantRealtimeInvalidation } from '@/lib/realtime/use-realtime-invalidation';
import {
  fetchInboxConversationPage,
  fetchInboxMessagePage,
  sendInboxWhatsAppMessage,
  type InboxConversation,
} from './inbox-api';

function formatTime(value: string | null) {
  if (!value) return '';
  const date = new Date(value);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit' }).format(date)
    : new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short' }).format(date);
}

function channelLabel(channel: string) {
  if (channel === 'WHATSAPP_BUSINESS') return 'WhatsApp';
  if (channel === 'INSTAGRAM_MESSAGING') return 'Instagram';
  if (channel === 'FACEBOOK_MESSENGER') return 'Messenger';
  if (channel === 'SMS') return 'SMS';
  if (channel === 'EMAIL') return 'Email';
  return channel.replaceAll('_', ' ');
}

function channelTone(channel: string) {
  if (channel === 'WHATSAPP_BUSINESS') return 'bg-emerald-50 text-emerald-700';
  if (channel === 'INSTAGRAM_MESSAGING') return 'bg-fuchsia-50 text-fuchsia-700';
  if (channel === 'FACEBOOK_MESSENGER') return 'bg-blue-50 text-blue-700';
  if (channel === 'EMAIL') return 'bg-slate-100 text-slate-700';
  return 'bg-orange-50 text-orange-700';
}

function ConversationListItem({
  conversation,
  active,
  onClick,
}: {
  conversation: InboxConversation;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`w-full border-b px-4 py-3 text-left transition-colors ${active ? 'bg-blue-50' : 'hover:bg-slate-50'}`}
      onClick={onClick}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{conversation.customer_name}</p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {conversation.interested_model ?? conversation.phone ?? 'Customer conversation'}
          </p>
        </div>
        <time className="shrink-0 text-[11px] text-muted-foreground">
          {formatTime(conversation.last_message_at)}
        </time>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${channelTone(conversation.channel)}`}
        >
          {channelLabel(conversation.channel)}
        </span>
        <p className="min-w-0 truncate text-xs text-muted-foreground">
          {conversation.last_message_body ?? 'No message body available'}
        </p>
      </div>
    </button>
  );
}

function InboxEmpty({ label }: { label: string }) {
  return (
    <div className="flex h-full min-h-72 flex-col items-center justify-center p-8 text-center">
      <MessageCircleMore className="size-8 text-blue-600" />
      <p className="mt-3 font-semibold">{label}</p>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        Provider conversations will appear here automatically when they are connected and within
        your access scope.
      </p>
    </div>
  );
}

export function InboxWorkspace({ role }: { role: string }) {
  const session = useWorkspaceSession();
  const salesConsultantCache = useSalesConsultantCache();
  const queryScope = workspaceQueryScope(session);
  const [search, setSearch] = useState('');
  const [channel, setChannel] = useState('all');
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);
  const conversations = useQuery({
    queryKey: ['shared-inbox', ...queryScope, debouncedSearch, channel, page],
    queryFn: ({ signal }) =>
      fetchInboxConversationPage({ search: debouncedSearch, channel, page }, signal),
    staleTime: 60_000,
  });
  const activeConversation = useMemo(() => {
    const rows = conversations.data?.records ?? [];
    return rows.find((item) => item.id === selectedId) ?? rows[0] ?? null;
  }, [conversations.data?.records, selectedId]);
  const messages = useQuery({
    queryKey: ['shared-inbox-messages', ...queryScope, activeConversation?.id],
    queryFn: ({ signal }) =>
      fetchInboxMessagePage({ conversationId: activeConversation!.id }, signal),
    enabled: Boolean(activeConversation),
    staleTime: 30_000,
  });
  useTenantRealtimeInvalidation(session?.organizationId, [
    { resource: 'communications', queryKeys: [['shared-inbox'], ['shared-inbox-messages']] },
  ]);
  const canSend =
    Boolean(session?.organizationId) &&
    hasWorkspacePermission(session, 'message.send') &&
    activeConversation?.channel === 'WHATSAPP_BUSINESS' &&
    activeConversation.status === 'OPEN';
  const send = useMutation({
    mutationFn: () => {
      if (!session?.organizationId || !activeConversation) throw new Error('INBOX_NOT_READY');
      return sendInboxWhatsAppMessage({
        organizationId: session.organizationId,
        conversationId: activeConversation.id,
        body: draft.trim(),
      });
    },
    onSuccess: async () => {
      setDraft('');
      await salesConsultantCache.settle('inbox.message.sent');
      toast.add({
        type: 'success',
        title: 'Message sent',
        description: 'The provider accepted the WhatsApp message.',
      });
    },
    onError: (error) => {
      const code = error instanceof Error ? error.message : '';
      toast.add({
        type: 'error',
        title: 'Message was not sent',
        description:
          code === 'WHATSAPP_TEMPLATE_REQUIRED'
            ? 'The WhatsApp service window has closed. Use an approved template.'
            : 'Check the connected channel and try again.',
      });
    },
  });

  if (!hasWorkspacePermission(session, 'message.view')) {
    return <InboxEmpty label="Messages are not available for your role" />;
  }

  const totalPages = Math.max(1, Math.ceil((conversations.data?.total ?? 0) / 25));

  if (conversations.isPending) return <InboxSkeleton />;

  return (
    <div className="mx-auto max-w-[1800px] space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="mb-2 text-xs text-muted-foreground">Workspace / Inbox</div>
          <h1 className="text-2xl font-bold tracking-tight">Customer inbox</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage authorized customer conversations across connected channels.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void conversations.refetch()}
          disabled={conversations.isFetching}
        >
          <RefreshCw className={`size-4 ${conversations.isFetching ? 'animate-spin' : ''}`} />{' '}
          Refresh
        </Button>
      </div>
      <Card className="sales-consultant-list-card overflow-hidden shadow-none">
        <div className="grid min-h-[calc(100vh-230px)] lg:grid-cols-[320px_minmax(0,1fr)_300px]">
          <aside className="flex min-h-0 flex-col border-r">
            <div className="space-y-2 border-b p-3">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setPage(1);
                  }}
                  className="pl-9"
                  placeholder="Search customer or mobile"
                />
              </div>
              <Select
                value={channel}
                onValueChange={(value) => {
                  setChannel(value);
                  setPage(1);
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All connected channels</SelectItem>
                  <SelectItem value="WHATSAPP_BUSINESS">WhatsApp</SelectItem>
                  <SelectItem value="INSTAGRAM_MESSAGING">Instagram</SelectItem>
                  <SelectItem value="FACEBOOK_MESSENGER">Facebook Messenger</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {conversations.isPending ? (
                <div className="p-5 text-sm text-muted-foreground">Loading conversations…</div>
              ) : conversations.data?.records.length ? (
                conversations.data.records.map((conversation) => (
                  <ConversationListItem
                    key={conversation.id}
                    conversation={conversation}
                    active={activeConversation?.id === conversation.id}
                    onClick={() => setSelectedId(conversation.id)}
                  />
                ))
              ) : (
                <InboxEmpty label="No conversations found" />
              )}
            </div>
            <div className="flex items-center justify-between border-t p-3 text-xs text-muted-foreground">
              <span>{conversations.data?.total ?? 0} conversations</span>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="icon"
                  className="size-7"
                  disabled={page <= 1}
                  onClick={() => setPage((value) => value - 1)}
                >
                  <ChevronLeft className="size-3.5" />
                </Button>
                <span>
                  {page}/{totalPages}
                </span>
                <Button
                  variant="outline"
                  size="icon"
                  className="size-7"
                  disabled={page >= totalPages}
                  onClick={() => setPage((value) => value + 1)}
                >
                  <ChevronLeft className="size-3.5 rotate-180" />
                </Button>
              </div>
            </div>
          </aside>
          <main className="flex min-h-0 flex-col bg-slate-50/30">
            {activeConversation ? (
              <>
                <div className="flex items-center justify-between gap-3 border-b bg-white p-4">
                  <div className="min-w-0">
                    <p className="truncate font-semibold">{activeConversation.customer_name}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {activeConversation.phone ?? 'Contact not available'} ·{' '}
                      {channelLabel(activeConversation.channel)}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 rounded px-2 py-1 text-xs font-medium ${channelTone(activeConversation.channel)}`}
                  >
                    {activeConversation.status}
                  </span>
                </div>
                <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
                  {messages.isPending ? (
                    <p className="text-sm text-muted-foreground">Loading messages…</p>
                  ) : messages.data?.records.length ? (
                    messages.data.records.map((message) => (
                      <div
                        key={message.id}
                        className={`flex ${message.direction === 'OUTBOUND' ? 'justify-end' : 'justify-start'}`}
                      >
                        <div
                          className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm shadow-sm ${message.direction === 'OUTBOUND' ? 'bg-emerald-100 text-slate-900' : 'bg-white border'}`}
                        >
                          <p className="whitespace-pre-wrap">
                            {message.body ?? 'Attachment or provider event'}
                          </p>
                          <p className="mt-1 text-right text-[10px] text-muted-foreground">
                            {new Intl.DateTimeFormat('en-IN', {
                              hour: '2-digit',
                              minute: '2-digit',
                            }).format(new Date(message.sent_at))}
                            {message.delivery_status ? ` · ${message.delivery_status}` : ''}
                          </p>
                        </div>
                      </div>
                    ))
                  ) : (
                    <InboxEmpty label="No messages in this conversation" />
                  )}
                </div>
                <div className="border-t bg-white p-3">
                  {canSend ? (
                    <div className="flex items-end gap-2">
                      <Textarea
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        placeholder="Type a WhatsApp message…"
                        maxLength={4096}
                        className="min-h-10 resize-none"
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' && !event.shiftKey) {
                            event.preventDefault();
                            if (draft.trim()) send.mutate();
                          }
                        }}
                      />
                      <Button
                        size="icon"
                        disabled={!draft.trim() || send.isPending}
                        onClick={() => send.mutate()}
                      >
                        {send.isPending ? (
                          <LoaderCircle className="size-4 animate-spin" />
                        ) : (
                          <Send className="size-4" />
                        )}
                      </Button>
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      {activeConversation.channel === 'WHATSAPP_BUSINESS'
                        ? 'You do not have permission to send from this conversation.'
                        : `${channelLabel(activeConversation.channel)} replies become available after its server-side provider adapter is connected.`}
                    </p>
                  )}
                </div>
              </>
            ) : (
              <InboxEmpty label="Select a conversation" />
            )}
          </main>
          <aside className="hidden border-l bg-white lg:block">
            {activeConversation ? (
              <div className="space-y-5 p-5">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Customer details
                  </p>
                  <div className="mt-3 flex items-center gap-3">
                    <span className="grid size-10 place-items-center rounded-full bg-blue-50 text-blue-600">
                      <UserRound className="size-5" />
                    </span>
                    <div>
                      <p className="font-semibold">{activeConversation.customer_name}</p>
                      <p className="text-xs text-muted-foreground">
                        {activeConversation.phone ?? '—'}
                      </p>
                    </div>
                  </div>
                </div>
                <div className="space-y-3 border-t pt-4">
                  <Detail label="Channel" value={channelLabel(activeConversation.channel)} />
                  <Detail
                    label="Assigned user"
                    value={activeConversation.assigned_user_name ?? 'Unassigned'}
                  />
                  <Detail
                    label="Interested model"
                    value={activeConversation.interested_model ?? '—'}
                  />
                </div>
                <div className="space-y-2 border-t pt-4">
                  {activeConversation.customer_id && (
                    <Button asChild variant="outline" className="w-full">
                      <Link href={`/${role}/customers/${activeConversation.customer_id}`}>
                        Customer 360
                      </Link>
                    </Button>
                  )}
                  {activeConversation.lead_id && (
                    <Button asChild variant="outline" className="w-full">
                      <Link href={`/${role}/leads/${activeConversation.lead_id}`}>
                        Lead details
                      </Link>
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <InboxEmpty label="Customer details" />
            )}
          </aside>
        </div>
      </Card>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-medium">{value}</p>
    </div>
  );
}
