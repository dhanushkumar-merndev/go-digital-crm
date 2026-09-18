'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { useMemo, useRef, useState } from 'react';
import { PersonalWhatsAppDialog } from './personal-whatsapp-dialog';
import { PersonalWhatsAppTemplatePicker } from './personal-whatsapp-template-picker';
import { InboxLeadContext } from './inbox-lead-context';
import { InboxMessageScroller } from './inbox-message-scroller';
import {
  acknowledgeUnknownWhatsAppMessage,
  fetchPersonalWhatsAppStatus,
  personalWhatsAppReason,
  syncPersonalWhatsApp,
} from './personal-whatsapp-api';
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
  if (channel === 'WHATSAPP_BUSINESS') return 'Official WhatsApp';
  if (channel === 'WHATSAPP_PERSONAL') return 'My WhatsApp';
  if (channel === 'INSTAGRAM_MESSAGING') return 'Instagram';
  if (channel === 'FACEBOOK_MESSENGER') return 'Messenger';
  if (channel === 'SMS') return 'SMS';
  if (channel === 'EMAIL') return 'Email';
  return channel.replaceAll('_', ' ');
}

function channelTone(channel: string) {
  if (channel === 'WHATSAPP_PERSONAL') return 'bg-teal-50 text-teal-700';
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
    <div className="flex h-full min-h-36 flex-col items-center justify-center p-8 text-center">
      <MessageCircleMore className="size-8 text-blue-600" />
      <p className="mt-3 font-semibold">{label}</p>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        Provider conversations will appear here automatically when they are connected and within
        your access scope.
      </p>
    </div>
  );
}

export function InboxWorkspace({
  role,
  leadId,
  customerId,
  embedded = false,
  readOnly = false,
}: {
  role: string;
  leadId?: string;
  customerId?: string;
  embedded?: boolean;
  readOnly?: boolean;
}) {
  const session = useWorkspaceSession();
  const salesConsultantCache = useSalesConsultantCache();
  const queryScope = workspaceQueryScope(session);
  const [search, setSearch] = useState('');
  const [channel, setChannel] = useState('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [draftConversation, setDraftConversation] = useState<string | null>(null);
  const sendKey = useRef<{ context: string; id: string } | null>(null);
  const queryClient = useQueryClient();
  const refreshes = useRef<number[]>([]);
  const debouncedSearch = useDebouncedValue(search, 300);
  const conversations = useInfiniteQuery({
    queryKey: ['shared-inbox', ...queryScope, leadId, customerId, debouncedSearch, channel],
    initialPageParam: 1,
    queryFn: ({ signal, pageParam }) =>
      fetchInboxConversationPage(
        { search: debouncedSearch, channel, page: pageParam, leadId, customerId },
        signal,
      ),
    getNextPageParam: (lastPage, _pages, lastPageParam) =>
      lastPage.records.length && lastPageParam * 25 < lastPage.total
        ? lastPageParam + 1
        : undefined,
    staleTime: 60_000,
    // Realtime is primary; recover missed events while viewing the first page.
    refetchInterval: (query) => (query.state.data?.pages.length === 1 ? 15_000 : false),
    retry: 1,
  });
  const conversationRows = useMemo(
    () => [
      ...new Map(
        (conversations.data?.pages.flatMap((page) => page.records) ?? []).map((row) => [
          row.id,
          row,
        ]),
      ).values(),
    ],
    [conversations.data?.pages],
  );
  const activeConversation = useMemo(() => {
    const rows = conversationRows;
    return rows.find((item) => item.id === selectedId) ?? rows[0] ?? null;
  }, [conversationRows, selectedId]);
  const [historySelection, setHistorySelection] = useState<{
    conversationId: string;
    leadId: string | null;
  } | null>(null);
  const historyLeadId =
    leadId ??
    (historySelection?.conversationId === activeConversation?.id
      ? historySelection?.leadId
      : undefined) ??
    undefined;
  const viewLeadHistory =
    !leadId && activeConversation
      ? (id: string) => {
          setHistorySelection({
            conversationId: activeConversation.id,
            leadId: id === 'all' ? null : id,
          });
        }
      : undefined;
  const messages = useInfiniteQuery({
    queryKey: ['shared-inbox-messages', ...queryScope, activeConversation?.id, historyLeadId],
    initialPageParam: { beforeAt: null as string | null, beforeId: null as string | null },
    queryFn: ({ signal, pageParam }) =>
      fetchInboxMessagePage(
        { conversationId: activeConversation!.id, leadId: historyLeadId, ...pageParam },
        signal,
      ),
    getNextPageParam: (lastPage) =>
      lastPage.has_more
        ? { beforeAt: lastPage.next_before_at, beforeId: lastPage.next_before_id }
        : undefined,
    enabled: Boolean(activeConversation),
    staleTime: 30_000,
    refetchInterval: (query) => (query.state.data?.pages.length === 1 ? 5000 : false),
    retry: 1,
  });
  const personalConversation = activeConversation?.channel === 'WHATSAPP_PERSONAL';
  const personalStatus = useQuery({
    queryKey: ['personal-whatsapp-status', ...queryScope, activeConversation?.id],
    queryFn: ({ signal }) => fetchPersonalWhatsAppStatus(activeConversation?.id, signal),
    enabled: personalConversation,
    refetchInterval: (query) => {
      const status = query.state.data;
      return !status || status.send_disabled_reason ? 2000 : 15_000;
    },
    retry: 1,
    staleTime: 0,
    gcTime: 0,
    meta: { persist: false },
  });
  const messageRows =
    messages.data?.pages
      .slice()
      .reverse()
      .flatMap((item) => item.records) ?? [];
  const draftContext = `${activeConversation?.id}:${activeConversation?.lead_id}:${historyLeadId}`;
  const visibleDraft = draftConversation === draftContext ? draft : '';
  useTenantRealtimeInvalidation(session?.organizationId, [
    {
      resource: 'communications',
      queryKeys: [
        ['shared-inbox', ...queryScope],
        ['shared-inbox-messages', ...queryScope],
        ['personal-whatsapp-status', ...queryScope],
      ],
      tableQueryKeys: { templates: [['personal-whatsapp-templates', ...queryScope]] },
    },
  ]);
  const syncHistory = useMutation({
    mutationFn: () => {
      if (!activeConversation) throw new Error('PERSONAL_WHATSAPP_DISCONNECTED');
      return syncPersonalWhatsApp(activeConversation.id);
    },
    onSuccess: () =>
      toast.add({
        type: 'success',
        title: 'Text history requested',
        description:
          'Keep your phone online. Available text from the last 30 days will appear in All enquiries; media is skipped. WhatsApp may return no additional history.',
      }),
    onError: (error) =>
      toast.add({
        type: 'error',
        title: 'Sync could not start',
        description:
          personalWhatsAppReason(error instanceof Error ? error.message : null) ??
          'Reconnect My WhatsApp and try again.',
      }),
  });
  const canSend =
    !readOnly &&
    (!historyLeadId || activeConversation?.lead_id === historyLeadId) &&
    Boolean(session?.organizationId) &&
    hasWorkspacePermission(session, 'message.send') &&
    (activeConversation?.channel === 'WHATSAPP_BUSINESS' ||
      (personalConversation &&
        personalStatus.isSuccess &&
        personalStatus.data &&
        !personalStatus.data.send_disabled_reason)) &&
    activeConversation.status === 'OPEN';
  const send = useMutation({
    mutationFn: (
      input: Parameters<typeof sendInboxWhatsAppMessage>[0] & {
        context: string;
        startedAt: string;
      },
    ) => sendInboxWhatsAppMessage(input),
    onSuccess: (result, input) => {
      if (draftContext === input.context && visibleDraft.trim() === input.body) setDraft('');
      sendKey.current = null;
      // Refresh each resource once, without extending the send spinner through list refetches.
      salesConsultantCache.invalidate('inbox.message.sent');
      void queryClient.invalidateQueries({
        queryKey: ['personal-whatsapp-status', ...queryScope],
      });
      toast.add({
        type: result?.status === 'UNKNOWN' ? 'error' : 'success',
        title:
          result?.status === 'UNKNOWN'
            ? 'Send result unconfirmed'
            : result?.status === 'PENDING'
              ? 'Message pending'
              : 'Message sent',
        description:
          result?.status === 'UNKNOWN'
            ? 'Check WhatsApp on your phone. This message will not be resent automatically.'
            : 'The latest delivery status appears beside the message.',
      });
    },
    onError: (error) => {
      const code = error instanceof Error ? error.message : '';
      void queryClient.invalidateQueries({
        queryKey: ['personal-whatsapp-status', ...queryScope],
      });
      toast.add({
        type: 'error',
        title: 'Message was not sent',
        description:
          code === 'LEAD_CONTEXT_CHANGED'
            ? 'The working lead changed. Check the selected lead before sending again.'
            : code.startsWith('PERSONAL_WHATSAPP_')
              ? (personalWhatsAppReason(code) ?? 'Reply unavailable.')
              : code === 'WHATSAPP_TEMPLATE_REQUIRED'
                ? 'The WhatsApp service window has closed. Use an approved template.'
                : 'Check the connected channel and try again.',
      });
    },
  });
  function sendReply() {
    if (
      !session?.organizationId ||
      !activeConversation ||
      !canSend ||
      send.isPending ||
      !visibleDraft.trim()
    )
      return;
    const context = `${draftContext}:${visibleDraft.trim()}`;
    if (sendKey.current?.context !== context)
      sendKey.current = { context, id: crypto.randomUUID() };
    send.mutate({
      organizationId: session.organizationId,
      conversationId: activeConversation.id,
      expectedLeadId: activeConversation.lead_id,
      body: visibleDraft.trim(),
      applicationMessageId: sendKey.current.id,
      context: draftContext,
      startedAt: new Date().toISOString(),
    });
  }
  const pendingReply =
    send.variables?.context === draftContext &&
    !send.isError &&
    (send.isPending || (send.isSuccess && send.data?.message_id)) &&
    !messageRows.some((message) =>
      send.data?.message_id
        ? message.id === send.data.message_id
        : message.direction === 'OUTBOUND' &&
          message.body === send.variables?.body &&
          message.sent_at >= send.variables.startedAt,
    )
      ? send.variables
      : null;
  const acknowledge = useMutation({
    mutationFn: acknowledgeUnknownWhatsAppMessage,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['shared-inbox-messages', ...queryScope] });
      await queryClient.invalidateQueries({
        queryKey: ['personal-whatsapp-status', ...queryScope],
      });
    },
    onError: () =>
      toast.add({
        type: 'error',
        title: 'Unable to acknowledge message',
        description: 'Please try again.',
      }),
  });

  if (!hasWorkspacePermission(session, 'message.view')) {
    return <InboxEmpty label="Messages are not available for your role" />;
  }

  if (conversations.isPending) return <InboxSkeleton embedded={embedded} />;

  return (
    <div
      className={`mx-auto max-w-[1800px] ${embedded ? 'space-y-4' : 'flex h-[calc(100dvh-106px)] flex-col gap-3'}`}
    >
      <div className="flex shrink-0 flex-wrap items-end justify-between gap-3">
        <div>
          {!embedded && <div className="mb-2 text-xs text-muted-foreground">Workspace / Inbox</div>}
          <h2 className={embedded ? 'text-lg font-semibold' : 'text-2xl font-bold tracking-tight'}>
            {leadId ? 'This lead’s conversations' : 'Customer inbox'}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {historyLeadId
              ? 'Only messages assigned to this enquiry are shown.'
              : 'Select a conversation, then choose an enquiry on the right to view its messages.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {personalConversation && (
            <Button
              variant="outline"
              size="sm"
              disabled={syncHistory.isPending || personalStatus.data?.status !== 'CONNECTED'}
              onClick={() => syncHistory.mutate()}
              title="Request available text history for this customer. Reconnect My WhatsApp first if disconnected."
            >
              {syncHistory.isPending ? 'Requesting…' : 'Sync text history'}
            </Button>
          )}
          {/* Linking is a personal-channel action, so it stays off Official
              WhatsApp and Messenger. It has to be reachable from the default
              "All connected channels" view as well, or someone who has never
              linked cannot find it: the button was the only way to discover the
              feature, and it was hidden behind a filter they had no reason to
              pick first. */}
          {(channel === 'WHATSAPP_PERSONAL' || channel === 'all') &&
            ['telecaller', 'sales-consultant'].includes(role) &&
            hasWorkspacePermission(session, 'message.send') && (
              <PersonalWhatsAppDialog scope={queryScope} />
            )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const now = Date.now();
              refreshes.current = refreshes.current.filter((time) => now - time < 60_000);
              if (refreshes.current.length >= 3) {
                toast.add({
                  type: 'error',
                  title: 'Refresh limit reached',
                  description: 'Please wait a minute before refreshing again.',
                });
                return;
              }
              refreshes.current.push(now);
              void conversations.refetch();
              if (activeConversation) void messages.refetch();
              if (personalConversation) void personalStatus.refetch();
            }}
            disabled={conversations.isFetching}
          >
            <RefreshCw className={`size-4 ${conversations.isFetching ? 'animate-spin' : ''}`} />{' '}
            Refresh
          </Button>
        </div>
      </div>
      <Card
        className={`sales-consultant-list-card min-h-0 overflow-hidden shadow-none ${embedded ? 'h-[680px]' : 'flex-1'}`}
      >
        <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)] lg:grid-cols-[280px_minmax(0,1fr)_280px]">
          <aside className={`${selectedId ? 'hidden lg:flex' : 'flex'} min-h-0 flex-col border-r`}>
            <div className="shrink-0 space-y-2 border-b p-3">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setSelectedId(null);
                  }}
                  className="pl-9"
                  placeholder="Search customer or mobile"
                />
              </div>
              <Select
                value={channel}
                onValueChange={(value) => {
                  setChannel(value);
                  setSelectedId(null);
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All connected channels</SelectItem>
                  <SelectItem value="WHATSAPP_BUSINESS">Official WhatsApp</SelectItem>
                  <SelectItem value="WHATSAPP_PERSONAL">My WhatsApp</SelectItem>
                  <SelectItem value="INSTAGRAM_MESSAGING">Instagram</SelectItem>
                  <SelectItem value="FACEBOOK_MESSENGER">Facebook Messenger</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div
              key={`${debouncedSearch}:${channel}`}
              className="min-h-0 flex-1 overflow-y-auto"
              onScroll={(event) => {
                const node = event.currentTarget;
                if (
                  node.scrollHeight - node.scrollTop - node.clientHeight < 100 &&
                  conversations.hasNextPage &&
                  !conversations.isFetching
                )
                  void conversations.fetchNextPage();
              }}
            >
              {conversations.isPending ? (
                <div className="p-5 text-sm text-muted-foreground">Loading conversations…</div>
              ) : conversations.isError ? (
                <p role="alert" className="p-4 text-sm text-destructive">
                  Conversations could not be loaded. Try Refresh.
                </p>
              ) : conversationRows.length ? (
                conversationRows.map((conversation) => (
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
            <div className="flex shrink-0 items-center justify-between border-t p-3 text-xs text-muted-foreground">
              <span>
                {conversationRows.length} of {conversations.data?.pages[0]?.total ?? 0}{' '}
                conversations
              </span>
              {conversations.hasNextPage && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={conversations.isFetching}
                  onClick={() => void conversations.fetchNextPage()}
                >
                  {conversations.isFetchingNextPage ? 'Loading…' : 'Load more'}
                </Button>
              )}
            </div>
          </aside>
          <main
            className={`${selectedId ? 'flex' : 'hidden lg:flex'} min-h-0 flex-col bg-slate-50/30`}
          >
            {activeConversation ? (
              <>
                <div className="flex shrink-0 items-center justify-between gap-3 border-b bg-white p-4">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="lg:hidden"
                    aria-label="Back to conversations"
                    onClick={() => setSelectedId(null)}
                  >
                    <ChevronLeft className="size-4" />
                  </Button>
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
                <div className="shrink-0 max-h-48 overflow-y-auto px-4 pb-3 lg:hidden">
                  <InboxLeadContext
                    key={activeConversation.id}
                    conversation={activeConversation}
                    leadId={historyLeadId}
                    onViewLeadChange={viewLeadHistory}
                    disabled={send.isPending || readOnly}
                  />
                </div>
                <InboxMessageScroller
                  key={`${activeConversation.id}:${historyLeadId ?? 'all'}`}
                  identity={`${activeConversation.id}:${historyLeadId ?? 'all'}`}
                  count={messageRows.length + (pendingReply ? 1 : 0)}
                  newestId={pendingReply?.applicationMessageId ?? messageRows.at(-1)?.id}
                  hasMore={messages.hasNextPage}
                  fetching={messages.isFetching}
                  loadMore={() => messages.fetchNextPage()}
                >
                  {messages.isPending ? (
                    <p className="text-sm text-muted-foreground">Loading messages…</p>
                  ) : messages.isError ? (
                    <p role="alert" className="text-sm text-destructive">
                      Messages could not be loaded.
                    </p>
                  ) : messageRows.length ? (
                    messageRows.map((message) => (
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
                          {!historyLeadId && typeof message.metadata.lead_id === 'string' && (
                            <Link
                              className="mt-1 block text-[10px] text-muted-foreground underline"
                              href={`/${role}/leads/${message.metadata.lead_id}`}
                            >
                              Lead {message.metadata.lead_id.slice(0, 8)}
                            </Link>
                          )}
                          {personalConversation && message.delivery_status === 'UNKNOWN' && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="mt-2"
                              disabled={acknowledge.isPending}
                              onClick={() => acknowledge.mutate(message.id)}
                            >
                              I checked this message on my phone
                            </Button>
                          )}
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
                  ) : pendingReply ? null : (
                    <InboxEmpty label="No messages in this conversation" />
                  )}
                  {pendingReply && (
                    <div className="flex justify-end" aria-live="polite">
                      <div className="max-w-[85%] rounded-2xl bg-emerald-100 px-3 py-2 text-sm text-slate-900">
                        <p className="whitespace-pre-wrap">{pendingReply.body}</p>
                        <p className="mt-1 text-right text-[10px] text-muted-foreground">
                          {send.isPending ? 'Sending…' : (send.data?.status ?? 'Submitted')}
                        </p>
                      </div>
                    </div>
                  )}
                </InboxMessageScroller>
                <div className="shrink-0 border-t bg-white p-3">
                  {personalConversation && (
                    <div className="mb-2 space-y-1 text-xs text-muted-foreground">
                      <p>
                        My WhatsApp · Reply only · {personalStatus.data?.daily_sent ?? '—'} / 50
                        replies in 24 hours
                      </p>
                      {personalStatus.data?.reply_window_expires_at && (
                        <p>
                          Reply window ends{' '}
                          {new Date(personalStatus.data.reply_window_expires_at).toLocaleString()}
                        </p>
                      )}
                      {personalStatus.data?.next_send_at &&
                        personalStatus.data.send_disabled_reason ===
                          'PERSONAL_WHATSAPP_RATE_LIMITED' && (
                          <p>
                            Next reply available{' '}
                            {new Date(personalStatus.data.next_send_at).toLocaleTimeString()}
                          </p>
                        )}
                    </div>
                  )}
                  {canSend ? (
                    <div className="flex items-end gap-2">
                      <Textarea
                        ref={composerRef}
                        value={visibleDraft}
                        onChange={(event) => {
                          setDraftConversation(draftContext);
                          setDraft(event.target.value);
                        }}
                        placeholder="Type a WhatsApp message…"
                        maxLength={personalConversation ? 1500 : 4096}
                        className="min-h-10 resize-none"
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' && !event.shiftKey) {
                            event.preventDefault();
                            sendReply();
                          }
                        }}
                      />
                      <Button
                        size="icon"
                        disabled={!visibleDraft.trim() || send.isPending}
                        onClick={sendReply}
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
                      {historyLeadId && activeConversation.lead_id !== historyLeadId
                        ? 'This is earlier history for this lead. Choose “Work on this lead” before sending new messages here.'
                        : personalConversation
                          ? personalStatus.isError
                            ? 'Connection status is unavailable. Sending is disabled until it can be verified.'
                            : (personalWhatsAppReason(personalStatus.data?.send_disabled_reason) ??
                              'Checking your connection…')
                          : activeConversation.channel === 'WHATSAPP_BUSINESS'
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
          <aside className="hidden min-h-0 overflow-y-auto border-l bg-white lg:block">
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
                <InboxLeadContext
                  key={activeConversation.id}
                  conversation={activeConversation}
                  leadId={historyLeadId}
                  onViewLeadChange={viewLeadHistory}
                  disabled={send.isPending || readOnly}
                />
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
                {personalConversation &&
                  !readOnly &&
                  hasWorkspacePermission(session, 'message.send') && (
                    <PersonalWhatsAppTemplatePicker
                      key={draftContext}
                      conversationId={activeConversation.id}
                      disabled={!canSend || send.isPending}
                      onUse={(body) => {
                        setDraftConversation(draftContext);
                        setDraft(body);
                        composerRef.current?.focus();
                      }}
                    />
                  )}
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
