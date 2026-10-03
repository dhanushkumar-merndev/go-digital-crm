'use client';

import {
  onlineManager,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  Check,
  CheckCheck,
  ChevronLeft,
  CircleAlert,
  Clock3,
  MessageCircleMore,
  RefreshCw,
  Search,
  Send,
  UserRound,
  WifiOff,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
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

// WhatsApp-style ticks, kept to three states: Sending, Sent, Seen. An
// unconfirmed (UNKNOWN) send is still waiting for WhatsApp's receipt, which
// upgrades it by itself, so it reads as Sending rather than as an error.
function MessageStatus({ status }: { status: string | null }) {
  if (!status) return null;
  const view =
    status === 'READ'
      ? { icon: <CheckCheck className="size-3 text-sky-600" />, label: 'Seen', tone: '' }
      : status === 'DELIVERED'
        ? { icon: <CheckCheck className="size-3" />, label: 'Sent', tone: '' }
        : status === 'SENT'
          ? { icon: <Check className="size-3" />, label: 'Sent', tone: '' }
          : status === 'FAILED'
            ? { icon: <CircleAlert className="size-3" />, label: 'Not sent', tone: 'text-red-600' }
            : status === 'UNCONFIRMED'
              ? { icon: <Clock3 className="size-3" />, label: 'Not confirmed', tone: '' }
              : { icon: <Clock3 className="size-3" />, label: 'Sending', tone: '' };
  return (
    <span className={`inline-flex items-center gap-0.5 ${view.tone}`}>
      {view.icon}
      {view.label}
    </span>
  );
}

// A reply typed in the composer. It shows immediately and is dispatched in
// order, one at a time, because personal WhatsApp allows a single send in
// flight and a short gap between sends. `id` is the idempotency key.
type OutboxItem = {
  id: string;
  organizationId: string;
  conversationId: string;
  expectedLeadId: string | null;
  context: string;
  body: string;
  personal: boolean;
  state: 'queued' | 'sent' | 'failed';
  attempts: number;
  createdAt: number;
  retryAt?: number;
  messageId?: string;
  status?: string;
};
// Server says "not yet" (previous send still settling): wait for WhatsApp's
// receipt and try the same message again instead of failing it.
const TRANSIENT_SEND_ERRORS = [
  'PERSONAL_WHATSAPP_SEND_UNRESOLVED',
  'PERSONAL_WHATSAPP_RATE_LIMITED',
];
// The gateway rejected before dispatch (the server marks that attempt FAILED),
// so nothing reached WhatsApp: queue it again under a new key once reconnected.
const REJECTED_BEFORE_SEND = ['PERSONAL_WHATSAPP_DISCONNECTED', 'PERSONAL_WHATSAPP_LEASE_LOST'];
function sendFailureReason(code: string) {
  return code === 'LEAD_CONTEXT_CHANGED'
    ? 'The working lead changed. Check the selected lead before sending again.'
    : code.startsWith('PERSONAL_WHATSAPP_')
      ? (personalWhatsAppReason(code) ?? 'Reply unavailable.')
      : code === 'WHATSAPP_TEMPLATE_REQUIRED'
        ? 'The WhatsApp service window has closed. Use an approved template.'
        : 'Check the connected channel and try again.';
}

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
  initialChannel = 'all',
  initialConversationId = null,
}: {
  role: string;
  leadId?: string;
  customerId?: string;
  embedded?: boolean;
  readOnly?: boolean;
  initialChannel?: string;
  initialConversationId?: string | null;
}) {
  const session = useWorkspaceSession();
  const salesConsultantCache = useSalesConsultantCache();
  const queryScope = workspaceQueryScope(session);
  const [search, setSearch] = useState('');
  const [channel, setChannel] = useState(initialChannel);
  const [selectedId, setSelectedId] = useState<string | null>(initialConversationId);
  const [draft, setDraft] = useState('');
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [draftConversation, setDraftConversation] = useState<string | null>(null);
  const [outbox, setOutbox] = useState<OutboxItem[]>([]);
  const dispatching = useRef<string | null>(null);
  const lastSendDone = useRef(0);
  // Set when the last result left the server with an unresolved send, so the
  // next dispatch waits for a status read taken after it.
  const awaitStatus = useRef(false);
  const online = useSyncExternalStore(
    (notify) => onlineManager.subscribe(notify),
    () => onlineManager.isOnline(),
    () => true,
  );
  const [dispatchWake, setDispatchWake] = useState(0);
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
    // Keep receiving updates after the reader has loaded earlier timeline pages.
    // This reads CRM messages only; it never requests WhatsApp history.
    refetchInterval: 5000,
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
    mutationFn: (conversation: { id: string; customerName: string }) =>
      syncPersonalWhatsApp(conversation.id),
    onSuccess: (_result, conversation) =>
      toast.add({
        type: 'success',
        title: `History requested for ${conversation.customerName}`,
        description:
          'Only this chat is being synced. Keep your phone online. Available text from the last 30 days will appear in timeline order under All enquiries; media is skipped.',
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
  // Personal replies may still be typed while the previous one settles or the
  // short send gap runs; they wait in the outbox. Other reasons block the composer.
  const personalReason = personalStatus.data?.send_disabled_reason ?? null;
  const canCompose =
    canSend ||
    (!readOnly &&
      (!historyLeadId || activeConversation?.lead_id === historyLeadId) &&
      Boolean(session?.organizationId) &&
      hasWorkspacePermission(session, 'message.send') &&
      personalConversation &&
      Boolean(personalStatus.data) &&
      (personalReason === 'PERSONAL_WHATSAPP_SEND_UNRESOLVED' ||
        personalReason === 'PERSONAL_WHATSAPP_DISCONNECTED') &&
      activeConversation.status === 'OPEN');
  const send = useMutation({
    mutationFn: (item: OutboxItem) =>
      sendInboxWhatsAppMessage({
        organizationId: item.organizationId,
        conversationId: item.conversationId,
        expectedLeadId: item.expectedLeadId,
        body: item.body,
        applicationMessageId: item.id,
      }),
  });
  const sendMutate = send.mutateAsync;
  const outboxBusy = outbox.some((item) => item.state === 'queued');
  useEffect(() => {
    if (dispatching.current || !online) return;
    const next = outbox.find((item) => item.state === 'queued');
    if (!next) return;
    if (next.personal) {
      const reason = personalStatus.data?.send_disabled_reason;
      if (!personalStatus.data) return;
      // A confirmed send frees the slot at once; only an unresolved one needs
      // a fresh status read first. Other reasons are waited out, never failed.
      if (awaitStatus.current && (reason || personalStatus.dataUpdatedAt <= lastSendDone.current))
        return;
      if (reason && reason !== 'PERSONAL_WHATSAPP_SEND_UNRESOLVED') return;
    }
    const wait = (next.retryAt ?? 0) - Date.now();
    if (wait > 0) {
      const timer = setTimeout(() => setDispatchWake((value) => value + 1), wait);
      return () => clearTimeout(timer);
    }
    dispatching.current = next.id;
    const settle = (patch: Partial<OutboxItem>, unresolved: boolean) => {
      dispatching.current = null;
      awaitStatus.current = unresolved;
      lastSendDone.current = Date.now();
      setOutbox((items) =>
        items.map((item) => (item.id === next.id ? { ...item, ...patch } : item)),
      );
      void queryClient.invalidateQueries({
        queryKey: ['personal-whatsapp-status', ...queryScope],
      });
    };
    sendMutate(next)
      .then((result) => {
        salesConsultantCache.invalidate('inbox.message.sent');
        settle(
          { state: 'sent', messageId: result?.message_id, status: result?.status },
          next.personal && !['SENT', 'DELIVERED', 'READ', 'FAILED'].includes(result?.status ?? ''),
        );
      })
      .catch((error: unknown) => {
        const code = error instanceof Error ? error.message : '';
        // Lost network: keep it queued and resend with the same idempotency
        // key, so a request that did reach the server is never sent twice.
        if (code === 'NETWORK_UNAVAILABLE') {
          settle({ retryAt: Date.now() + 2000 }, false);
          return;
        }
        if (REJECTED_BEFORE_SEND.includes(code) && next.attempts < 6) {
          settle(
            { id: crypto.randomUUID(), attempts: next.attempts + 1, retryAt: Date.now() + 2000 },
            true,
          );
          return;
        }
        if (TRANSIENT_SEND_ERRORS.includes(code) && next.attempts < 6) {
          settle({ attempts: next.attempts + 1, retryAt: Date.now() + 1000 }, true);
          return;
        }
        settle({ state: 'failed' }, false);
        toast.add({
          type: 'error',
          title: 'Message was not sent',
          description: sendFailureReason(code),
        });
      });
  }, [
    outbox,
    online,
    personalStatus.data,
    personalStatus.dataUpdatedAt,
    dispatchWake,
    sendMutate,
    queryClient,
    queryScope,
    salesConsultantCache,
  ]);
  function sendReply() {
    const body = visibleDraft.trim();
    if (!session?.organizationId || !activeConversation || !canCompose || !body) return;
    setOutbox((items) => [
      ...items,
      {
        id: crypto.randomUUID(),
        organizationId: session.organizationId!,
        conversationId: activeConversation.id,
        expectedLeadId: activeConversation.lead_id,
        context: draftContext,
        body,
        personal: Boolean(personalConversation),
        state: 'queued',
        attempts: 0,
        createdAt: Date.now(),
      },
    ]);
    setDraft('');
    composerRef.current?.focus();
  }
  function retryOutbox(id: string) {
    // An explicit retry is a new send attempt, so it gets a new idempotency key.
    setOutbox((items) =>
      items.map((item) =>
        item.id === id
          ? {
              ...item,
              id: crypto.randomUUID(),
              state: 'queued',
              attempts: 0,
              createdAt: Date.now(),
            }
          : item,
      ),
    );
  }
  // Optimistic bubbles for this thread. Once a reply is dispatched, the list
  // poll can return its server row before the send call resolves, so each
  // dispatched bubble hides behind at most one matching server row.
  const claimedRows = new Set<string>();
  const visibleOutbox = outbox.filter((item) => {
    if (item.context !== draftContext) return false;
    const dispatched =
      item.state === 'sent' || (item.state === 'queued' && send.variables?.id === item.id);
    if (!dispatched) return true;
    const row = messageRows.find(
      (message) =>
        !claimedRows.has(message.id) &&
        (item.messageId
          ? message.id === item.messageId
          : message.direction === 'OUTBOUND' &&
            message.body === item.body &&
            Date.parse(message.sent_at) >= item.createdAt - 60_000),
    );
    if (!row) return true;
    claimedRows.add(row.id);
    return false;
  });
  const queuedHere = visibleOutbox.filter((item) => item.state === 'queued').length;
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
      className={`mx-auto max-w-[1800px] ${embedded ? 'space-y-4' : 'flex flex-col gap-3'}`}
      style={!embedded ? { height: 'calc(100vh / var(--canvas-zoom, 1) - 110px)' } : undefined}
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
            title="Refresh sent and received messages already in the CRM. Older WhatsApp history is synced separately inside each chat."
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
          <aside
            className={`${selectedId ? 'hidden lg:flex' : 'flex'} min-h-0 flex-col border-r bg-slate-50/50`}
          >
            <div className="shrink-0 space-y-2 border-b bg-white p-3">
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
            <div className="flex shrink-0 items-center justify-between border-t bg-white p-3 text-xs text-muted-foreground">
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
                    disabled={outboxBusy || readOnly}
                  />
                </div>
                <InboxMessageScroller
                  key={`${activeConversation.id}:${historyLeadId ?? 'all'}`}
                  identity={`${activeConversation.id}:${historyLeadId ?? 'all'}`}
                  count={messageRows.length + visibleOutbox.length}
                  newestId={visibleOutbox.at(-1)?.id ?? messageRows.at(-1)?.id}
                  hasMore={messages.hasNextPage}
                  fetching={messages.isFetching}
                  loadMore={() => messages.fetchNextPage()}
                >
                  {personalConversation && !readOnly && (
                    <div className="flex flex-wrap items-center justify-center gap-2 rounded-md border border-dashed bg-white px-3 py-2 text-xs text-muted-foreground">
                      <span>Older text history · {activeConversation.customer_name}</span>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={
                          syncHistory.isPending || personalStatus.data?.status !== 'CONNECTED'
                        }
                        onClick={() =>
                          syncHistory.mutate({
                            id: activeConversation.id,
                            customerName: activeConversation.customer_name,
                          })
                        }
                        title={`Request older text messages only for ${activeConversation.customer_name}. Keep your phone online.`}
                      >
                        {syncHistory.isPending &&
                        syncHistory.variables?.id === activeConversation.id
                          ? 'Requesting…'
                          : 'Sync this chat’s history'}
                      </Button>
                      {historyLeadId && <span>Synced history is shown under All enquiries.</span>}
                    </div>
                  )}
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
                            <p className="mt-2 text-[11px] text-muted-foreground">
                              WhatsApp has not confirmed this yet. It updates by itself when
                              confirmed. If it never arrived, check your phone:
                            </p>
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
                          <p className="mt-1 flex items-center justify-end gap-1 text-[10px] text-muted-foreground">
                            {new Intl.DateTimeFormat('en-IN', {
                              hour: '2-digit',
                              minute: '2-digit',
                            }).format(new Date(message.sent_at))}
                            {message.direction === 'OUTBOUND' && (
                              <MessageStatus status={message.delivery_status} />
                            )}
                          </p>
                        </div>
                      </div>
                    ))
                  ) : visibleOutbox.length ? null : (
                    <InboxEmpty label="No messages in this conversation" />
                  )}
                  {visibleOutbox.map((item) => (
                    <div key={item.id} className="flex justify-end" aria-live="polite">
                      <div
                        className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm text-slate-900 shadow-sm ${item.state === 'failed' ? 'border border-red-200 bg-red-50' : 'bg-emerald-100'}`}
                      >
                        <p className="whitespace-pre-wrap">{item.body}</p>
                        <p className="mt-1 flex justify-end text-[10px] text-muted-foreground">
                          <MessageStatus
                            status={
                              item.state === 'failed'
                                ? 'FAILED'
                                : item.state === 'sent'
                                  ? (item.status ?? 'SENT')
                                  : 'SENDING'
                            }
                          />
                        </p>
                        {item.state === 'failed' && (
                          <div className="mt-2 flex justify-end gap-2">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                setOutbox((items) => items.filter((entry) => entry.id !== item.id))
                              }
                            >
                              Remove
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => retryOutbox(item.id)}
                            >
                              Retry
                            </Button>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </InboxMessageScroller>
                <div className="shrink-0 border-t bg-white p-3">
                  {personalConversation && (
                    <div className="mb-2 space-y-1 text-xs text-muted-foreground">
                      <p>
                        My WhatsApp · {personalStatus.data?.daily_sent ?? '—'} /{' '}
                        {personalStatus.data?.daily_limit ?? 50} messages in 24 hours
                      </p>
                      {personalStatus.data?.next_send_at &&
                        personalStatus.data.send_disabled_reason ===
                          'PERSONAL_WHATSAPP_RATE_LIMITED' && (
                          <p>
                            Next message available{' '}
                            {new Date(personalStatus.data.next_send_at).toLocaleTimeString()}
                          </p>
                        )}
                    </div>
                  )}
                  {(!online ||
                    queuedHere > 0 ||
                    (personalConversation &&
                      personalReason === 'PERSONAL_WHATSAPP_DISCONNECTED')) && (
                    <p
                      className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground"
                      aria-live="polite"
                    >
                      {online ? (
                        <RefreshCw className="size-3 animate-spin" />
                      ) : (
                        <WifiOff className="size-3" />
                      )}
                      {!online
                        ? `You're offline. ${queuedHere ? `${queuedHere} message${queuedHere === 1 ? '' : 's'} will` : 'Messages will'} send when you're back online.`
                        : personalConversation &&
                            personalReason === 'PERSONAL_WHATSAPP_DISCONNECTED'
                          ? `Reconnecting to WhatsApp…${queuedHere ? ` ${queuedHere} message${queuedHere === 1 ? '' : 's'} will send automatically.` : ''}`
                          : `Syncing ${queuedHere} message${queuedHere === 1 ? '' : 's'}…`}
                    </p>
                  )}
                  {canCompose ? (
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
                      <Button size="icon" disabled={!visibleDraft.trim()} onClick={sendReply}>
                        <Send className="size-4" />
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
                  disabled={outboxBusy || readOnly}
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
                      disabled={!canCompose}
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
