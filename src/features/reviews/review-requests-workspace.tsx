'use client';

import { TablePagination, type TablePageSize } from '@/components/shared/table-pagination';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import type { PageSpec } from '@/lib/domain';
import { PageHeader } from '@/components/shared/page-header';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  CircleCheck,
  Clock3,
  ExternalLink,
  MessageSquareHeart,
  Search,
  Send,
  Star,
  TriangleAlert,
} from 'lucide-react';
import { useState } from 'react';
import { EChart } from '@/components/charts/e-chart';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PerformanceDateRangeSelector } from '@/components/shared/performance-date-range-selector';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { Metric } from '@/lib/domain';
import { performanceRangeForLastDays } from '@/lib/performance-date-range';
import { formatNationalPhone } from '@/lib/phone';
import {
  fetchMyReviewRequests,
  getReviewRequestErrorMessage,
  reviewRequestKeys,
  type ReviewRequestRecord,
  type ReviewRequestView,
} from './review-request-api';
import { SendReviewRequestDialog, type ReviewTarget } from './send-review-request-dialog';

const stateBadge: Record<
  ReviewRequestRecord['state'],
  { label: string; variant: 'success' | 'warning' | 'secondary' }
> = {
  FILLED: { label: 'Filled', variant: 'success' },
  AWAITING: { label: 'Awaiting', variant: 'warning' },
  EXPIRED: { label: 'Expired', variant: 'secondary' },
};
const channelLabel: Record<string, string> = { WHATSAPP: 'WhatsApp', SMS: 'SMS', LINK: 'Link' };

function Stars({ rating }: { rating: number }) {
  return (
    <span className="flex items-center gap-0.5" aria-label={`${rating} out of 5`}>
      {[1, 2, 3, 4, 5].map((value) => (
        <Star
          key={value}
          className={
            value <= rating ? 'size-3.5 fill-amber-400 text-amber-400' : 'size-3.5 text-muted'
          }
        />
      ))}
    </span>
  );
}

function formatDate(value: string | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Kolkata',
  }).format(new Date(value));
}

const percent = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0);

/**
 * Reviews for a Telecaller or Sales Consultant: who they asked, who answered,
 * the stars, and how many were taken on to Google. Own requests only; a
 * request belongs to whoever sent it.
 */
export function ReviewRequestsWorkspace({ spec }: { spec: PageSpec }) {
  const session = useWorkspaceSession();
  const scope = workspaceQueryScope(session);
  const [range, setRange] = useState(() => performanceRangeForLastDays(30));
  const [view, setView] = useState<ReviewRequestView>('ALL');
  const [term, setTerm] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<TablePageSize>(25);
  const [sending, setSending] = useState<{ target: ReviewTarget | null } | null>(null);
  const debouncedTerm = useDebouncedValue(term.trim());
  if (debouncedTerm !== search) {
    setSearch(debouncedTerm);
    setPage(1);
  }
  const query = useQuery({
    queryKey: reviewRequestKeys.workspace(scope, range, view, search, page, pageSize),
    queryFn: ({ signal }) => fetchMyReviewRequests({ range, view, search, page, pageSize }, signal),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  const header = (
    <PageHeader
      spec={{ ...spec, primaryAction: undefined }}
      description="Ask customers for a review and see who answered, the stars they gave and who went on to Google."
      actions={
        <>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <PerformanceDateRangeSelector
              value={range}
              onChange={(next) => {
                setRange(next);
                setPage(1);
              }}
            />
            <Button onClick={() => setSending({ target: null })}>
              <Send /> Ask for a review
            </Button>
          </div>
        </>
      }
    />
  );
  const dialog = sending ? (
    <SendReviewRequestDialog
      key={sending.target?.leadId ?? 'pick'}
      open
      onOpenChange={(open) => !open && setSending(null)}
      target={sending.target}
    />
  ) : null;

  if (query.isPending)
    return (
      <div className="mx-auto w-full space-y-5">
        {header}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} className="h-[104px] rounded-xl" />
          ))}
        </div>
        <div className="grid gap-4 xl:grid-cols-3">
          <Skeleton className="h-80 rounded-xl xl:col-span-2" />
          <Skeleton className="h-80 rounded-xl" />
        </div>
        <Skeleton className="h-96 rounded-xl" />
        {dialog}
      </div>
    );
  if (query.isError)
    return (
      <div className="mx-auto w-full space-y-5">
        {header}
        <Card className="shadow-none">
          <CardContent className="p-10 text-center">
            <TriangleAlert className="mx-auto text-destructive" />
            <p className="mt-3 font-semibold">Reviews could not be loaded</p>
            <p className="text-sm text-muted-foreground">
              {getReviewRequestErrorMessage(query.error)}
            </p>
            <Button className="mt-4" variant="outline" onClick={() => void query.refetch()}>
              Try again
            </Button>
          </CardContent>
        </Card>
        {dialog}
      </div>
    );

  const { kpis, ratings, daily, records, total } = query.data;
  const metrics: Metric[] = [
    {
      label: 'Requests Sent',
      value: String(kpis.sent),
      icon: Send,
      tone: 'bg-blue-50 text-blue-600',
      helper: 'Links you sent in this period',
    },
    {
      label: 'Customers Filled',
      value: String(kpis.filled),
      icon: CircleCheck,
      tone: 'bg-emerald-50 text-emerald-600',
      helper: `${percent(kpis.filled, kpis.sent)}% response rate`,
    },
    {
      label: 'Awaiting',
      value: String(kpis.awaiting),
      icon: Clock3,
      tone: 'bg-amber-50 text-amber-600',
      helper: `${kpis.expired} expired unanswered`,
    },
    {
      label: 'Average Rating',
      value: kpis.average_rating === null ? '—' : `${kpis.average_rating.toFixed(1)} ★`,
      icon: Star,
      tone: 'bg-yellow-50 text-yellow-600',
      helper: `${kpis.five_star} five-star`,
    },
    {
      label: 'Sent to Google',
      value: String(kpis.sent_to_google),
      icon: ExternalLink,
      tone: 'bg-violet-50 text-violet-600',
      helper: 'Opened your Google review page',
    },
    {
      label: 'Needs Attention',
      value: String(kpis.low_rating),
      icon: MessageSquareHeart,
      tone: 'bg-rose-50 text-rose-600',
      helper: '3 stars or fewer',
    },
  ];

  return (
    <div className="mx-auto w-full space-y-5">
      {header}
      <KpiGrid metrics={metrics} variant="classic" />
      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="shadow-none xl:col-span-2">
          <CardHeader>
            <CardTitle className="text-sm">Requests Sent vs Filled</CardTitle>
          </CardHeader>
          <CardContent>
            <EChart
              kind="line"
              data={daily.map((row) => ({
                name: row.day.slice(5),
                value: row.sent,
                secondary: row.filled,
              }))}
              seriesNames={['Sent', 'Filled']}
            />
          </CardContent>
        </Card>
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-sm">Star Ratings</CardTitle>
          </CardHeader>
          <CardContent>
            <EChart
              kind="bar"
              data={ratings.map((row) => ({ name: `${row.rating} ★`, value: row.count }))}
            />
          </CardContent>
        </Card>
      </div>
      <Card className="shadow-none">
        <CardHeader className="flex flex-col gap-3 border-b p-4 sm:flex-row sm:items-center sm:justify-between">
          <Tabs
            value={view}
            onValueChange={(value) => {
              setView(value as ReviewRequestView);
              setPage(1);
            }}
          >
            <TabsList>
              <TabsTrigger value="ALL">All</TabsTrigger>
              <TabsTrigger value="AWAITING">Awaiting</TabsTrigger>
              <TabsTrigger value="FILLED">Filled</TabsTrigger>
              <TabsTrigger value="EXPIRED">Expired</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="relative w-full sm:w-72">
            <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              placeholder="Search customer or phone"
              className="pl-8"
              aria-label="Search review requests"
            />
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Customer</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Sent</TableHead>
                <TableHead>Via</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Rating</TableHead>
                <TableHead>Review</TableHead>
                <TableHead>Google</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {records.length ? (
                records.map((record) => {
                  const badge = stateBadge[record.state];
                  return (
                    <TableRow key={record.feedback_id}>
                      <TableCell>
                        <p className="font-medium">{record.customer_name}</p>
                        {record.phone ? (
                          <p className="text-xs text-muted-foreground">
                            {formatNationalPhone(record.phone)}
                          </p>
                        ) : null}
                      </TableCell>
                      <TableCell>{record.interested_model ?? '—'}</TableCell>
                      <TableCell className="whitespace-nowrap">
                        {formatDate(record.sent_at)}
                      </TableCell>
                      <TableCell>{channelLabel[record.channel] ?? record.channel}</TableCell>
                      <TableCell>
                        <Badge variant={badge.variant}>{badge.label}</Badge>
                      </TableCell>
                      <TableCell>
                        {record.rating ? <Stars rating={record.rating} /> : '—'}
                      </TableCell>
                      <TableCell className="max-w-80">
                        {record.comments ? (
                          <p className="line-clamp-2 text-xs text-muted-foreground">
                            {record.comments}
                          </p>
                        ) : record.keywords.length ? (
                          <p className="truncate text-xs text-muted-foreground">
                            {record.keywords.join(', ')}
                          </p>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell>
                        {record.sent_to_google ? (
                          <Badge variant="violet">Opened</Badge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {record.state !== 'FILLED' && record.lead_id ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              setSending({
                                target: {
                                  leadId: record.lead_id!,
                                  customerName: record.customer_name,
                                  phone: record.phone,
                                },
                              })
                            }
                          >
                            Resend
                          </Button>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  );
                })
              ) : (
                <TableRow>
                  <TableCell colSpan={9} className="h-28 text-center text-muted-foreground">
                    {kpis.sent
                      ? 'No requests in this view.'
                      : 'No review requests yet. Use “Ask for a review” to send your first one.'}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
        <TablePagination
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={setPage}
          onPageSizeChange={(next) => {
            setPageSize(next);
            setPage(1);
          }}
        />
      </Card>
      <p className="text-center text-xs text-muted-foreground">
        Customers are taken to Google whatever they rate: asking only happy customers is review
        gating, which Google does not allow. 3-star-or-lower feedback also opens a customer-care
        case.
      </p>
      {dialog}
    </div>
  );
}
