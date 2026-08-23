'use client';

import { useQuery } from '@tanstack/react-query';
import {
  Building2,
  CalendarClock,
  FileCheck2,
  Landmark,
  LockKeyhole,
  MapPinned,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageHeader } from '@/components/shared/page-header';
import { PageSkeleton } from '@/components/shared/page-skeleton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import type { Metric, PageSpec } from '@/lib/domain';
import { fetchCompanyComplianceWorkspace } from './company-compliance-workspace-api';

const documentLabels = {
  OWNER_IDENTITY: 'Business Owner identity evidence',
  GST_CERTIFICATE: 'GST registration certificate',
  DEALERSHIP_AUTHORIZATION: 'Dealership / manufacturer authorization',
} as const;

function formatDate(value: string | null, includeTime = false) {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unavailable';
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    ...(includeTime ? { timeStyle: 'short' as const } : {}),
  }).format(date);
}

function formatBytes(value: number) {
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function statusVariant(status: string) {
  if (status === 'ACTIVE' || status === 'APPROVED') return 'success' as const;
  if (status === 'REJECTED') return 'destructive' as const;
  if (status === 'CHANGES_REQUIRED' || status === 'SUPPORT_MAINTENANCE')
    return 'secondary' as const;
  return 'outline' as const;
}

export function CompanyComplianceWorkspace({ spec }: { spec: PageSpec }) {
  const query = useQuery({
    queryKey: ['company-compliance'],
    queryFn: ({ signal }) => fetchCompanyComplianceWorkspace(signal),
    staleTime: 60_000,
  });

  if (query.isPending) return <PageSkeleton />;
  if (query.isError || !query.data)
    return (
      <Card className="mx-auto max-w-xl shadow-none">
        <CardContent className="p-10 text-center">
          <LockKeyhole className="mx-auto size-6 text-amber-600" />
          <p className="mt-3 font-semibold">Company compliance is unavailable</p>
          <p className="mt-2 text-sm text-muted-foreground">
            This read-only record requires an MFA-assured, organization-wide Business Owner or
            Client Admin session.
          </p>
          <Button className="mt-5" variant="outline" onClick={() => void query.refetch()}>
            <RefreshCw className="size-4" /> Try again
          </Button>
        </CardContent>
      </Card>
    );

  const { organization, branch_summary: branchSummary, latest_submission: submission } = query.data;
  const metrics: Metric[] = [
    {
      label: 'Tenant status',
      value: organization.status.replaceAll('_', ' '),
      icon: ShieldCheck,
      helper: 'Current platform access status',
    },
    {
      label: 'Active branches',
      value: `${branchSummary.active} / ${branchSummary.total}`,
      icon: Building2,
      helper: 'Non-deleted branch records',
    },
    {
      label: 'Compliance evidence',
      value: submission?.evidence.length.toLocaleString() ?? '0',
      icon: FileCheck2,
      helper: 'Latest onboarding submission only',
    },
    {
      label: 'Latest review',
      value: submission?.reviewed_at ? formatDate(submission.reviewed_at) : 'Pending',
      icon: CalendarClock,
      helper: submission ? `Submission v${submission.version}` : 'No submission recorded',
    },
  ];

  return (
    <div className="mx-auto max-w-[1500px] space-y-5">
      <PageHeader spec={{ ...spec, primaryAction: undefined, readOnly: true }} />
      <KpiGrid metrics={metrics} className="xl:grid-cols-4" />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.25fr)_minmax(340px,0.75fr)]">
        <Card className="shadow-none">
          <CardHeader className="border-b">
            <div className="flex items-start justify-between gap-4">
              <div>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Landmark className="size-4 text-primary" /> Registered organization
                </CardTitle>
                <CardDescription className="mt-1">
                  Current organization information held by the CRM.
                </CardDescription>
              </div>
              <Badge variant={statusVariant(organization.status)}>
                {organization.status.replaceAll('_', ' ')}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="grid gap-5 p-5 sm:grid-cols-2">
            <Detail label="Organization name" value={organization.name} />
            <Detail label="Legal name" value={organization.legal_name ?? 'Not recorded'} />
            <Detail label="GST number" value={organization.gst_number ?? 'Not recorded'} />
            <Detail label="CRM record created" value={formatDate(organization.created_at)} />
            <Detail
              label="Last organization update"
              value={formatDate(organization.updated_at, true)}
            />
          </CardContent>
        </Card>

        <Card className="shadow-none">
          <CardHeader className="border-b">
            <CardTitle className="flex items-center gap-2 text-base">
              <MapPinned className="size-4 text-primary" /> Authorized dealer information
            </CardTitle>
            <CardDescription>Captured in the latest onboarding submission.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 p-5">
            {submission ? (
              <>
                <Detail
                  label="Registered address"
                  value={submission.dealer_information.registered_address ?? 'Not recorded'}
                />
                <Detail
                  label="Dealer licence number"
                  value={submission.dealer_information.dealership_license_number ?? 'Not recorded'}
                />
                <Detail
                  label="Manufacturer names"
                  value={
                    submission.dealer_information.manufacturer_names?.join(', ') || 'Not recorded'
                  }
                />
                <Detail
                  label="Contact email"
                  value={submission.dealer_information.contact_email ?? 'Not recorded'}
                />
                <Detail
                  label="Contact phone"
                  value={submission.dealer_information.contact_phone ?? 'Not recorded'}
                />
              </>
            ) : (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No onboarding dealer information has been submitted.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.25fr)_minmax(340px,0.75fr)]">
        <Card className="shadow-none">
          <CardHeader className="border-b">
            <div className="flex items-start justify-between gap-4">
              <div>
                <CardTitle className="text-base">Latest compliance submission</CardTitle>
                <CardDescription>
                  Evidence is private. This page shows only metadata and does not create download
                  links.
                </CardDescription>
              </div>
              {submission ? (
                <Badge variant={statusVariant(submission.status)}>
                  {submission.status.replaceAll('_', ' ')}
                </Badge>
              ) : null}
            </div>
          </CardHeader>
          <CardContent className="p-5">
            {submission ? (
              <div className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-3">
                  <Detail label="Submission" value={`Version ${submission.version}`} />
                  <Detail label="Submitted" value={formatDate(submission.submitted_at, true)} />
                  <Detail label="Reviewed" value={formatDate(submission.reviewed_at, true)} />
                </div>
                {submission.review_note ? (
                  <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-sm text-amber-950">
                    <p className="font-medium">Platform review note</p>
                    <p className="mt-1 whitespace-pre-wrap text-amber-900/80">
                      {submission.review_note}
                    </p>
                  </div>
                ) : null}
                <Separator />
                <div className="grid gap-3 sm:grid-cols-3">
                  {submission.evidence.map((document) => (
                    <div key={document.document_type} className="rounded-lg border p-3">
                      <FileCheck2 className="size-4 text-emerald-600" />
                      <p className="mt-2 text-sm font-medium">
                        {documentLabels[document.document_type]}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {document.mime_type} · {formatBytes(document.size_bytes)}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Recorded {formatDate(document.uploaded_at)}
                      </p>
                    </div>
                  ))}
                  {!submission.evidence.length ? (
                    <p className="py-4 text-sm text-muted-foreground sm:col-span-3">
                      No active evidence metadata is available for this submission.
                    </p>
                  ) : null}
                </div>
              </div>
            ) : (
              <p className="py-10 text-center text-sm text-muted-foreground">
                No onboarding submission is available for this organization.
              </p>
            )}
          </CardContent>
        </Card>

        <Card className="shadow-none">
          <CardHeader className="border-b">
            <CardTitle className="text-base">Tenant status history</CardTitle>
            <CardDescription>Most recent authorized tenant lifecycle changes.</CardDescription>
          </CardHeader>
          <CardContent className="divide-y p-5">
            {query.data.status_history.map((event) => (
              <div
                key={`${event.to_status}:${event.created_at}`}
                className="py-3 first:pt-0 last:pb-0"
              >
                <div className="flex items-center justify-between gap-3">
                  <Badge variant={statusVariant(event.to_status)}>
                    {event.to_status.replaceAll('_', ' ')}
                  </Badge>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatDate(event.created_at, true)}
                  </span>
                </div>
                {event.reason ? (
                  <p className="mt-2 text-sm text-muted-foreground">{event.reason}</p>
                ) : null}
              </div>
            ))}
            {!query.data.status_history.length ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No status history is recorded.
              </p>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 break-words text-sm font-medium text-foreground">{value}</p>
    </div>
  );
}
