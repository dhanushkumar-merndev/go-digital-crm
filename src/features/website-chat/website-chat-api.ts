import { z } from 'zod';
import { websiteQuestionFields, websiteQuestionTypes } from '@/lib/providers/website-lead-adapter';

const questionSchema = z.object({
  id: z.string(),
  field: z.enum(websiteQuestionFields),
  type: z.enum(websiteQuestionTypes),
  prompt: z.string(),
  options: z.array(z.string()),
  required: z.boolean(),
});

const widgetConfigSchema = z.object({
  title: z.string(),
  greeting: z.string(),
  success_message: z.string(),
  accent_color: z.string(),
  allowed_origins: z.array(z.string()),
  questions: z.array(questionSchema),
  models: z.array(z.string()),
  branches: z.array(z.object({ id: z.string(), name: z.string() })),
  turnstile_site_key: z.string().nullable(),
});
export type PublicWebsiteWidgetConfig = z.infer<typeof widgetConfigSchema>;

const envelopeSchema = z.object({
  ok: z.boolean(),
  data: z.unknown(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      details: z.record(z.string(), z.unknown()).optional(),
    })
    .nullable(),
});

export class WebsiteChatError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly questionId?: string,
  ) {
    super(message);
  }
}

function functionUrl(name: string) {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, '');
  if (!base) throw new WebsiteChatError('NOT_CONFIGURED', 'Chat is not available right now.');
  return `${base}/functions/v1/${name}`;
}

async function readEnvelope(response: Response) {
  const parsed = envelopeSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success)
    throw new WebsiteChatError('UNAVAILABLE', 'Chat is not available right now.');
  if (!parsed.data.ok || parsed.data.error) {
    const error = parsed.data.error;
    const questionId = error?.details?.question_id;
    throw new WebsiteChatError(
      error?.code ?? 'UNAVAILABLE',
      error?.message ?? 'Something went wrong. Please try again.',
      typeof questionId === 'string' ? questionId : undefined,
    );
  }
  return parsed.data.data;
}

/** Called without a session: the widget key only names the dealer's chat. */
export async function fetchWebsiteWidgetConfig(publicKey: string) {
  const response = await fetch(
    `${functionUrl('website-widget-config')}?key=${encodeURIComponent(publicKey)}`,
  );
  return widgetConfigSchema.parse(await readEnvelope(response));
}

export async function submitWebsiteChat(input: {
  publicKey: string;
  chatId: string;
  answers: Record<string, string | boolean>;
  turnstileToken?: string;
  honeypot: string;
  parentOrigin?: string;
  pageUrl?: string;
}) {
  const response = await fetch(functionUrl('website-chat-lead'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      key: input.publicKey,
      chat_id: input.chatId,
      answers: input.answers,
      turnstile_token: input.turnstileToken,
      website: input.honeypot || undefined,
      parent_origin: input.parentOrigin,
      page_url: input.pageUrl,
    }),
  });
  return z
    .object({ accepted: z.boolean(), duplicate: z.boolean() })
    .parse(await readEnvelope(response));
}
