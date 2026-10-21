'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Sparkles } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  fetchCallAiPreferences,
  fetchCallAiState,
  isCallAiRunning,
  requestCallAiProcessing,
  saveCallAiPreferences,
} from './call-workspace-api';

const failureMessages: Record<string, string> = {
  INSUFFICIENT_CREDITS: 'The dealership does not have enough AI credits for this call.',
  SARVAM_API_KEY_MISSING: 'AI transcription is not configured yet.',
  GROQ_API_KEY_MISSING: 'AI transcription is not configured yet.',
  GROQ_ANALYSIS_MODEL_MISSING: 'AI transcription is not configured yet.',
  SARVAM_AUDIO_TOO_LONG: 'Recordings longer than two hours cannot be transcribed.',
  SARVAM_EMPTY_TRANSCRIPT: 'No speech was found in this recording.',
  SARVAM_JOB_FAILED: 'The recording could not be transcribed. Credits were returned.',
  SARVAM_TIMEOUT: 'Transcription took too long. Credits were returned.',
  CALL_RECORDING_EMPTY: 'The recording file is empty. Upload it again.',
  CALL_RECORDING_UNREADABLE: 'The recording file could not be read. Upload it again.',
};

function failureMessage(code: string) {
  if (failureMessages[code]) return failureMessages[code];
  if (/^(SARVAM|GROQ)_/.test(code))
    return 'The AI service had a problem. Try again in a few minutes.';
  if (code.startsWith('AI_CREDIT_')) return 'AI credits could not be reserved. Try again shortly.';
  return 'Try again in a moment.';
}

function requestMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (message.includes('AI_ALREADY_DONE')) return 'This call is already transcribed.';
  if (message.includes('CALL_RECORDING_NOT_READY')) return 'Upload the recording first.';
  if (message.includes('PERMISSION_DENIED')) return 'You cannot process this call.';
  return 'Processing could not start. Try again.';
}

/**
 * Transcribe & summarise on demand. Uploaded recordings are not processed
 * automatically unless the user switches that on, so credits go to the calls
 * that need them.
 */
export function CallAiProcessingControl({
  callId,
  onCompleted,
}: {
  callId: string;
  onCompleted: () => void;
}) {
  const queryClient = useQueryClient();
  const state = useQuery({
    queryKey: ['call-ai-state', callId],
    queryFn: ({ signal }) => fetchCallAiState(callId, signal),
    refetchInterval: (query) => (isCallAiRunning(query.state.data) ? 5000 : false),
  });
  const preferences = useQuery({
    queryKey: ['call-ai-preferences'],
    queryFn: ({ signal }) => fetchCallAiPreferences(signal),
  });
  const request = useMutation({
    mutationFn: requestCallAiProcessing,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['call-ai-state', callId] }),
  });
  const savePreference = useMutation({
    mutationFn: saveCallAiPreferences,
    onSuccess: (saved) => queryClient.setQueryData(['call-ai-preferences'], saved),
  });

  const running = isCallAiRunning(state.data);
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running && state.data?.job?.status === 'COMPLETED') onCompleted();
    wasRunning.current = running;
  }, [running, state.data?.job?.status, onCompleted]);

  if (!state.data) return null;
  const data = state.data;
  const failed = data.job?.status === 'FAILED';

  return (
    <div className="space-y-3 rounded-lg border border-violet-200 p-3">
      {running ? (
        <p className="flex items-center gap-2 text-sm text-slate-700">
          <Loader2 className="size-4 animate-spin text-violet-600" />
          Transcribing, translating and summarising. This usually takes a few minutes.
        </p>
      ) : failed ? (
        <p className="text-sm text-destructive">
          Processing failed. {failureMessage(data.job?.safe_error_code ?? '')}
        </p>
      ) : null}
      {data.can_request && (
        <Button
          type="button"
          size="sm"
          className="w-full"
          disabled={request.isPending}
          onClick={() => request.mutate({ callId })}
        >
          <Sparkles className="size-3.5" />
          {request.isPending ? 'Starting…' : failed ? 'Try again' : 'Transcribe & summarise'}
        </Button>
      )}
      {data.can_request && (
        <p className="text-xs text-muted-foreground">
          {data.estimated_credits
            ? `About ${data.estimated_credits} AI credit${data.estimated_credits === 1 ? '' : 's'} for this call, charged on its real length.`
            : 'Charged by call length: about 1 AI credit per minute.'}
        </p>
      )}
      {data.can_regenerate && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="w-full text-muted-foreground"
          disabled={request.isPending}
          onClick={() => request.mutate({ callId, regenerate: true })}
        >
          Regenerate (uses AI credits)
        </Button>
      )}
      {request.isError && (
        <p className="text-xs text-destructive">{requestMessage(request.error)}</p>
      )}
      {preferences.data && (
        <div className="flex items-center justify-between gap-3 border-t pt-3">
          <Label htmlFor="call-ai-auto-process" className="text-xs font-normal leading-5">
            Transcribe my uploaded recordings automatically (uses AI credits for every call)
          </Label>
          <Switch
            id="call-ai-auto-process"
            checked={preferences.data.auto_process}
            disabled={savePreference.isPending}
            onCheckedChange={(checked) => savePreference.mutate({ autoProcess: checked })}
          />
        </div>
      )}
    </div>
  );
}
