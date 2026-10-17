'use client';

import { useQuery } from '@tanstack/react-query';
import { MessageSquareText } from 'lucide-react';
import { z } from 'zod';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { createClient } from '@/lib/supabase/client';
import { readRpc } from '@/lib/supabase/read-rpc';

const answersSchema = z.array(
  z.object({ id: z.string(), question: z.string(), answer: z.string() }),
);

/**
 * What the visitor answered in the website chat (or sent as city/message
 * through the Lead API). Requirement answers are already in the requirement
 * cards; this keeps the full transcript, including custom questions.
 */
export function LeadWebsiteAnswers({ leadId }: { leadId: string }) {
  const answers = useQuery({
    queryKey: ['lead-website-answers', leadId],
    queryFn: async ({ signal }) =>
      answersSchema.parse(
        (await readRpc(
          createClient().rpc('get_lead_website_answers', { target_lead_id: leadId }),
          signal,
        )) ?? [],
      ),
  });
  if (!answers.data?.length) return null;
  return (
    <Card className="shadow-none">
      <CardHeader className="border-b px-5 py-4">
        <CardTitle className="flex items-center gap-2 text-sm">
          <MessageSquareText className="size-4 text-blue-600" /> Website answers
        </CardTitle>
      </CardHeader>
      <CardContent className="p-5">
        <dl className="space-y-3 text-sm">
          {answers.data.map((entry) => (
            <div key={entry.id}>
              <dt className="text-[11px] text-muted-foreground">{entry.question}</dt>
              <dd className="mt-0.5 font-medium break-words">{entry.answer}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}
