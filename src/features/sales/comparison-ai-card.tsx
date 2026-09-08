'use client';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import { z } from 'zod';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';

export function ComparisonAiCard({ ourId, otherId }: { ourId: string; otherId: string }) {
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const client = useQueryClient();
  const session = useWorkspaceSession();
  const mutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await createClient().functions.invoke('vehicle-comparison-ai', {
        body: { our_id: ourId, other_id: otherId, request_id: requestId },
      });
      let response = data;
      if (error && 'context' in error && error.context instanceof Response)
        response = await error.context.json().catch(() => null);
      if (error || !response?.ok) {
        if (
          response?.error?.code === 'AI_REQUEST_FAILED' ||
          response?.error?.message?.includes('refunded')
        )
          setRequestId(crypto.randomUUID());
        throw new Error(
          response?.error?.message ??
            'AI is unavailable. Retry to check this request; it will not charge twice.',
        );
      }
      return z.object({ summary: z.string(), credits: z.number() }).parse(response.data);
    },
    onSettled: () => {
      void client.invalidateQueries({
        queryKey: ['header-credit-balance', ...workspaceQueryScope(session)],
      });
    },
  });
  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle className="text-base">AI comparison support</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Generate talking points from these specifications using your configured AI provider. Costs
          1 AI credit; only runs when you press the button.
        </p>
        <Button
          disabled={mutation.isPending || mutation.isSuccess}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending
            ? 'Generating…'
            : mutation.isSuccess
              ? 'Generated · 1 credit'
              : 'Generate comparison · 1 credit'}
        </Button>
        {mutation.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {mutation.error.message}
          </p>
        ) : null}
        {mutation.data ? (
          <>
            <p className="whitespace-pre-wrap text-sm">{mutation.data.summary}</p>
            <p className="text-xs text-muted-foreground">
              AI-generated — review against dealer-provided specifications before sharing with a
              customer.
            </p>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
