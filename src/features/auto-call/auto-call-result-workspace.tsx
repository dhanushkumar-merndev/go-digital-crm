'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, BadgeCheck, Bot, CalendarClock, FileAudio, PhoneCall } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import { SpeakerTranscript } from '@/features/calls/speaker-transcript';
import { leadStageVariant } from '@/features/leads/lead-stage-variant';
import { aiCallLanguageLabel } from './ai-call-script-definition';
import {
  aiCallOutcomeLabels,
  applyAutoCallSuggestions,
  autoCallErrorMessage,
  autoCallResultKey,
  createAudioPreviewUrl,
  fetchAutoCallResult,
  myAutoCallStatusKey,
  verifyAutoContact,
  type AutoCallResult,
} from './auto-call-api';
import { autoIvrFieldLabel, displayFieldValue } from './auto-ivr-definition';

const outcomeLabels: Record<string, string> = {
  ANSWERED: 'Answered',
  NO_INPUT: 'Picked up, nothing captured',
  NO_ANSWER: 'No answer',
  BUSY: 'Busy',
  FAILED: 'Call failed',
};

function formatDuration(value: number | null) {
  if (!value) return '—';
  return `${Math.floor(value / 60)}m ${value % 60}s`;
}

function RecordingCard({ recordings }: { recordings: AutoCallResult['recordings'] }) {
  const ready = recordings.find((recording) => recording.object_file_id);
  const [url, setUrl] = useState<string | null>(null);
  const open = useMutation({
    meta: { toast: false },
    mutationFn: (objectFileId: string) => createAudioPreviewUrl(objectFileId),
    onSuccess: setUrl,
    onError: () => toast.add({ type: 'error', title: 'The recording could not be opened' }),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FileAudio className="size-4" /> Recording
        </CardTitle>
      </CardHeader>
      <CardContent>
        {ready?.object_file_id ? (
          url ? (
            <audio controls autoPlay src={url} className="w-full" />
          ) : (
            <Button
              variant="outline"
              disabled={open.isPending}
              onClick={() => open.mutate(ready.object_file_id as string)}
            >
              {open.isPending ? 'Opening…' : 'Play recording'}
            </Button>
          )
        ) : (
          <p className="text-sm text-muted-foreground">
            {recordings.length
              ? 'The recording is still being copied from TeleCMI.'
              : 'No recording for this call.'}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function AiConversationCard({ data }: { data: AutoCallResult }) {
  const outcome = data.ai?.outcome;
  return (
    <Card className="lg:col-span-7">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Bot className="size-4" /> AI conversation
        </CardTitle>
        <CardDescription>
          {outcome
            ? `${aiCallOutcomeLabels[outcome]} · spoke ${aiCallLanguageLabel(data.ai?.language)}`
            : data.call.finalized
              ? 'The AI agent did not report this call.'
              : 'The summary appears when the call ends.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {data.ai?.summary ? (
          <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">{data.ai.summary}</div>
        ) : null}
        {data.transcript?.length ? (
          <SpeakerTranscript
            turns={data.transcript}
            fallbackText={null}
            separationMethod="PROVIDER_CHANNEL"
            compact
          />
        ) : (
          <p className="text-sm text-muted-foreground">No transcript for this call.</p>
        )}
      </CardContent>
    </Card>
  );
}

function Suggestions({ callId, data }: { callId: string; data: AutoCallResult }) {
  const queryClient = useQueryClient();
  const applicable = Object.keys(data.suggestions).filter(
    (field) => field !== 'callback_requested' && !(field in data.applied),
  );
  const [selected, setSelected] = useState<string[]>(applicable);
  const apply = useMutation({
    meta: { toast: false },
    mutationFn: () =>
      applyAutoCallSuggestions({ callId, fields: selected, requestId: crypto.randomUUID() }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: autoCallResultKey(callId) });
      toast.add({ type: 'success', title: 'Lead updated from the call' });
    },
    onError: (error) =>
      toast.add({
        type: 'error',
        title: 'Changes were not applied',
        description: autoCallErrorMessage(error, 'Reload and try again.'),
      }),
  });
  const fields = Object.keys(data.suggestions);
  if (!fields.length)
    return (
      <p className="text-sm text-muted-foreground">
        The answers on this call do not suggest any change.
      </p>
    );
  const canUpdate = data.lead?.can_update ?? false;
  return (
    <div className="grid gap-3">
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Field</TableHead>
              <TableHead>Now</TableHead>
              <TableHead>From the call</TableHead>
              <TableHead className="text-right">Apply</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {fields.map((field) => {
              const applied = field in data.applied;
              const callback = field === 'callback_requested';
              return (
                <TableRow key={field}>
                  <TableCell className="font-medium">{autoIvrFieldLabel(field)}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {displayFieldValue(field, data.lead?.current[field])}
                  </TableCell>
                  <TableCell>{displayFieldValue(field, data.suggestions[field])}</TableCell>
                  <TableCell className="text-right">
                    {applied ? (
                      <Badge variant="success">Applied</Badge>
                    ) : callback ? (
                      <span className="text-xs text-muted-foreground">Schedule below</span>
                    ) : (
                      <Switch
                        checked={selected.includes(field)}
                        disabled={!canUpdate}
                        aria-label={`Apply ${autoIvrFieldLabel(field)}`}
                        onCheckedChange={(checked) =>
                          setSelected((current) =>
                            checked
                              ? [...current, field]
                              : current.filter((item) => item !== field),
                          )
                        }
                      />
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      {applicable.length ? (
        <Button
          className="w-fit"
          disabled={!canUpdate || apply.isPending || selected.length === 0}
          onClick={() => apply.mutate()}
        >
          {apply.isPending ? 'Applying…' : `Apply ${selected.length} selected`}
        </Button>
      ) : null}
    </div>
  );
}

export function AutoCallResultWorkspace({ callId, role }: { callId: string; role: string }) {
  const queryClient = useQueryClient();
  const result = useQuery({
    queryKey: autoCallResultKey(callId),
    queryFn: ({ signal }) => fetchAutoCallResult(callId, signal),
    refetchInterval: (query) => (query.state.data?.call.finalized === false ? 10_000 : false),
  });
  const verify = useMutation({
    meta: { toast: false },
    mutationFn: () => verifyAutoContact(callId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: autoCallResultKey(callId) }),
        queryClient.invalidateQueries({ queryKey: myAutoCallStatusKey }),
      ]);
      toast.add({ type: 'success', title: 'Contact verified' });
    },
    onError: (error) =>
      toast.add({
        type: 'error',
        title: 'Not verified',
        description: autoCallErrorMessage(error, 'Reload and try again.'),
      }),
  });

  if (result.isPending)
    return (
      <div className="grid gap-4">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  if (result.isError || !result.data)
    return (
      <Alert>
        <AlertTitle>This auto call could not be opened</AlertTitle>
        <AlertDescription className="flex flex-wrap items-center gap-2">
          It may belong to a lead outside your access.
          <Button variant="outline" size="sm" onClick={() => void result.refetch()}>
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );

  const data = result.data;
  const lead = data.lead;
  const contactFromThisCall = lead?.auto_contact_call_id === callId;
  const answered = data.answers.filter((answer) => answer.key_pressed);
  const isAi = data.call.mode === 'AI_AGENT';
  const callLabel = isAi ? 'AI call' : 'Auto call';

  return (
    <div className="grid gap-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div className="grid gap-2">
          <Link
            href={`/${role}/my-leads`}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-3" /> My Leads
          </Link>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight">
              {lead?.customer_name ?? 'Auto call'}
            </h1>
            {lead ? (
              <Badge variant={leadStageVariant(lead.lifecycle_status)}>
                {lead.lifecycle_status}
              </Badge>
            ) : null}
            {contactFromThisCall ? (
              lead?.verified_at ? (
                <Badge variant="success">
                  <BadgeCheck className="mr-1 size-3" /> {callLabel} · Verified
                </Badge>
              ) : (
                <Badge variant="violet">{callLabel}</Badge>
              )
            ) : null}
          </div>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            <span className="flex items-center gap-1">
              <PhoneCall className="size-3.5" /> {lead?.phone ?? '—'}
            </span>
            <span>{lead?.interested_model ?? 'No model'}</span>
            <span>
              {data.call.finalized
                ? (outcomeLabels[data.call.outcome ?? ''] ?? data.call.status)
                : 'Call in progress'}
            </span>
            <span>{formatDuration(data.call.duration_seconds)}</span>
            <span>
              {new Date(data.call.started_at).toLocaleString('en-IN', {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            </span>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {lead ? (
            <Button variant="outline" asChild>
              <Link href={`/${role}/leads/${lead.id}`}>
                <CalendarClock className="size-4" /> Open lead (follow-up, transfer)
              </Link>
            </Button>
          ) : null}
          {contactFromThisCall && !lead?.verified_at ? (
            <Button
              disabled={!lead?.can_update || verify.isPending}
              onClick={() => verify.mutate()}
            >
              <BadgeCheck className="size-4" /> {verify.isPending ? 'Verifying…' : 'Verify contact'}
            </Button>
          ) : null}
        </div>
      </div>

      {lead?.verified_at ? (
        <p className="text-sm text-muted-foreground">
          Verified by {lead.verified_by_name ?? 'a team member'} on{' '}
          {new Date(lead.verified_at).toLocaleString('en-IN', {
            dateStyle: 'medium',
            timeStyle: 'short',
          })}
          .
        </p>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-12">
        {isAi ? (
          <AiConversationCard data={data} />
        ) : (
          <Card className="lg:col-span-7">
            <CardHeader>
              <CardTitle className="text-base">Answers</CardTitle>
              <CardDescription>
                {answered.length
                  ? `${answered.length} question${answered.length === 1 ? '' : 's'} answered on the keypad.`
                  : 'No key was pressed on this call.'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {data.answers.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing captured yet.</p>
              ) : (
                <div className="overflow-x-auto rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Question</TableHead>
                        <TableHead>Key</TableHead>
                        <TableHead>Meaning</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.answers.map((answer) => (
                        <TableRow key={`${answer.node_id}-${answer.attempt_no}`}>
                          <TableCell className="max-w-sm whitespace-normal">
                            {answer.question}
                          </TableCell>
                          <TableCell>
                            {answer.key_pressed ? (
                              <Badge variant="outline">{answer.key_pressed}</Badge>
                            ) : (
                              '—'
                            )}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {answer.meaning ?? 'No key pressed'}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        )}
        <div className="grid content-start gap-6 lg:col-span-5">
          <RecordingCard recordings={data.recordings} />
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Suggested changes</CardTitle>
          <CardDescription>
            Nothing changes on the lead until you apply it. A callback request is scheduled from the
            lead as a follow-up.
            {isAi ? ' The AI can mishear: check each value against the transcript.' : ''}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.call.finalized ? (
            <Suggestions key={Object.keys(data.applied).join(',')} callId={callId} data={data} />
          ) : (
            <p className="text-sm text-muted-foreground">Suggestions appear when the call ends.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
