'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Check,
  CircleAlert,
  FileAudio,
  FileText,
  LoaderCircle,
  Sparkles,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { AiCallFieldReviewSkeleton } from '@/components/skeletons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { toast } from '@/components/ui/toast';
import {
  fetchAiCallFieldReview,
  reviewAiCallFields,
  type AiFieldDecision,
} from './ai-call-field-review-api';

type DraftDecision = { decision: AiFieldDecision; value?: string };

function displayValue(value: unknown) {
  if (value === null || value === undefined || value === '') return 'Not set';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  return JSON.stringify(value);
}

function labelForField(value: string) {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDuration(value: number | null) {
  if (!value) return '—';
  return `${Math.floor(value / 60)}m ${value % 60}s`;
}

export function AiCallFieldReviewWorkspace({ callId, role }: { callId: string; role: string }) {
  const client = useQueryClient();
  const [drafts, setDrafts] = useState<Record<string, DraftDecision>>({});
  const workspace = useQuery({
    queryKey: ['ai-call-field-review', callId],
    queryFn: ({ signal }) => fetchAiCallFieldReview(callId, signal),
    staleTime: 30_000,
  });
  const review = useMutation({
    mutationFn: () => {
      if (!workspace.data?.extraction) throw new Error('AI_EXTRACTION_NOT_AVAILABLE');
      return reviewAiCallFields({
        extractionRunId: workspace.data.extraction.id,
        decisions: Object.entries(drafts).map(([field_key, item]) => ({
          field_key,
          decision: item.decision,
          ...(item.decision === 'EDITED' ? { value: item.value ?? '' } : {}),
        })),
        requestId: globalThis.crypto.randomUUID(),
      });
    },
    onSuccess: (result) => {
      toast.add({
        type: 'success',
        title: 'AI field review saved',
        description: result.accepted_fields.length
          ? `${result.accepted_fields.length} approved field(s) updated on the lead.`
          : 'Review decisions were saved without changing the lead.',
      });
      setDrafts({});
      client.invalidateQueries({ queryKey: ['ai-call-field-review', callId] });
      client.invalidateQueries({ queryKey: ['call-detail', callId] });
    },
    onError: () =>
      toast.add({
        type: 'error',
        title: 'Review could not be saved',
        description: 'The lead may have changed or you may no longer have update access.',
      }),
  });

  const fields = useMemo(
    () => workspace.data?.extraction?.fields ?? [],
    [workspace.data?.extraction?.fields],
  );
  const counts = useMemo(
    () => ({
      extracted: fields.length,
      reviewed: fields.filter((field) => field.decision !== 'PENDING').length,
      pending: fields.filter((field) => field.decision === 'PENDING').length,
    }),
    [fields],
  );
  if (workspace.isPending) return <AiCallFieldReviewSkeleton />;
  if (workspace.isError || !workspace.data)
    return (
      <div className="p-6 text-sm text-destructive">
        AI field review is unavailable for this call.
      </div>
    );

  const { call, transcript, summary, extraction } = workspace.data;
  const backHref = `/${role}/calls`;
  if (!extraction)
    return (
      <div className="mx-auto max-w-4xl space-y-5 p-6">
        <Button asChild variant="outline">
          <Link href={backHref}>
            <ArrowLeft /> Back to calls
          </Link>
        </Button>
        <Card className="shadow-none">
          <CardContent className="flex min-h-72 flex-col items-center justify-center text-center">
            <Sparkles className="mb-4 size-9 text-violet-600" />
            <h1 className="text-xl font-bold">No AI field review is ready</h1>
            <p className="mt-2 max-w-md text-sm text-muted-foreground">
              This call has no completed extraction run. When an authorized AI workflow produces
              suggestions, they will appear here for human review.
            </p>
          </CardContent>
        </Card>
      </div>
    );

  const setDecision = (fieldKey: string, decision: AiFieldDecision, suggested: unknown) =>
    setDrafts((current) => ({
      ...current,
      [fieldKey]: {
        decision,
        ...(decision === 'EDITED' ? { value: displayValue(suggested) } : {}),
      },
    }));

  return (
    <div className="mx-auto max-w-[1600px] space-y-5 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">Calls / AI field review</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight">AI Auto Field Fill Review</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Review AI-extracted values before they update CRM records.
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link href={backHref}>
              <ArrowLeft /> Back to calls
            </Link>
          </Button>
          <Button
            disabled={!Object.keys(drafts).length || review.isPending}
            onClick={() => review.mutate()}
          >
            {review.isPending ? <LoaderCircle className="animate-spin" /> : <Check />} Save review
          </Button>
        </div>
      </div>
      <Card className="shadow-none">
        <CardContent className="grid gap-4 p-4 sm:grid-cols-2 xl:grid-cols-6">
          <div>
            <p className="text-xs text-muted-foreground">Customer</p>
            <p className="mt-1 font-semibold">{call.customer_name}</p>
            <p className="text-sm text-muted-foreground">{call.phone}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Vehicle interest</p>
            <p className="mt-1 font-semibold">{call.interested_model ?? 'Not specified'}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Call started</p>
            <p className="mt-1 font-semibold">
              {new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(
                new Date(call.started_at),
              )}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Duration</p>
            <p className="mt-1 font-semibold">{formatDuration(call.duration_seconds)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Extraction status</p>
            <Badge className="mt-1" variant="secondary">
              {extraction.status}
            </Badge>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Fields</p>
            <p className="mt-1 font-semibold">
              {counts.extracted} extracted · {counts.pending} pending
            </p>
          </div>
        </CardContent>
      </Card>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(360px,0.8fr)]">
        <div className="space-y-5">
          <Card className="shadow-none">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <FileText className="size-4 text-blue-600" />
                Transcript summary
              </CardTitle>
              <CardDescription>Read-only provider transcript and AI summary.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 lg:grid-cols-2">
              <div>
                <p className="text-sm font-medium">AI summary</p>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
                  {summary ?? 'No summary is available.'}
                </p>
              </div>
              <div className="border-l pl-0 lg:pl-4">
                <p className="text-sm font-medium">Transcript</p>
                <p className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
                  {transcript?.text ?? 'No transcript is available.'}
                </p>
              </div>
            </CardContent>
          </Card>
          <Card className="shadow-none">
            <CardHeader>
              <CardTitle className="text-base">Extracted CRM fields</CardTitle>
              <CardDescription>
                Accept, reject, or edit each suggestion. Only accepted and edited allowlisted fields
                update the lead.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {fields.map((field) => {
                const draft = drafts[field.field_key];
                const selected: 'PENDING' | AiFieldDecision = draft?.decision ?? field.decision;
                return (
                  <div key={field.field_key} className="rounded-lg border p-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="font-medium">{labelForField(field.field_key)}</p>
                        <p className="mt-1 text-sm text-muted-foreground">
                          Current: {displayValue(field.current_value)}
                        </p>
                        <p className="mt-1 text-sm text-primary">
                          Suggested: {displayValue(field.suggested_value)}
                        </p>
                      </div>
                      <Badge
                        variant={
                          selected === 'REJECTED'
                            ? 'destructive'
                            : !draft && field.decision === 'PENDING'
                              ? 'outline'
                              : 'secondary'
                        }
                      >
                        {selected}
                      </Badge>
                    </div>
                    <Separator className="my-3" />
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant={selected === 'APPLIED' ? 'default' : 'outline'}
                        onClick={() =>
                          setDecision(field.field_key, 'APPLIED', field.suggested_value)
                        }
                      >
                        <Check /> Accept
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant={selected === 'REJECTED' ? 'destructive' : 'outline'}
                        onClick={() =>
                          setDecision(field.field_key, 'REJECTED', field.suggested_value)
                        }
                      >
                        <X /> Reject
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant={selected === 'EDITED' ? 'secondary' : 'outline'}
                        onClick={() =>
                          setDecision(field.field_key, 'EDITED', field.suggested_value)
                        }
                      >
                        Edit
                      </Button>
                      {selected === 'EDITED' && (
                        <Input
                          aria-label={`${labelForField(field.field_key)} edited value`}
                          className="max-w-sm"
                          value={draft?.value ?? ''}
                          onChange={(event) =>
                            setDrafts((current) => ({
                              ...current,
                              [field.field_key]: { decision: 'EDITED', value: event.target.value },
                            }))
                          }
                        />
                      )}
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        </div>
        <div className="space-y-5">
          <Card className="shadow-none">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Sparkles className="size-4 text-violet-600" />
                AI review assistant
              </CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg bg-blue-50 p-3">
                <p className="text-lg font-bold text-blue-700">{counts.extracted}</p>
                <p className="text-xs text-muted-foreground">Extracted</p>
              </div>
              <div className="rounded-lg bg-emerald-50 p-3">
                <p className="text-lg font-bold text-emerald-700">{counts.reviewed}</p>
                <p className="text-xs text-muted-foreground">Reviewed</p>
              </div>
              <div className="rounded-lg bg-amber-50 p-3">
                <p className="text-lg font-bold text-amber-700">{counts.pending}</p>
                <p className="text-xs text-muted-foreground">Pending</p>
              </div>
            </CardContent>
          </Card>
          <Card className="shadow-none">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <FileAudio className="size-4 text-blue-600" />
                Review safeguards
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p className="flex gap-2">
                <CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
                AI suggestions never update CRM until an authorized user accepts or edits them.
              </p>
              <p>
                Every decision is recorded in the audit log with the selected values. Unreviewed
                suggestions remain unchanged.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
