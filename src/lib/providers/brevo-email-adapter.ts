import 'server-only';
import type { EmailAdapter, EmailInput, EmailResult } from './contracts';

type BrevoResponse = { messageId?: string; code?: string; message?: string };

export class BrevoEmailAdapter implements EmailAdapter {
  constructor(private readonly apiKey = process.env.BREVO_API_KEY) {
    if (!apiKey) throw new Error('BREVO_API_KEY_MISSING');
  }

  async send(input: EmailInput): Promise<EmailResult> {
    const templateId = Number(input.templateId);
    if (!Number.isSafeInteger(templateId) || templateId <= 0)
      throw new Error('INVALID_BREVO_TEMPLATE_ID');
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'api-key': this.apiKey!,
        'idempotency-key': input.idempotencyKey,
      },
      body: JSON.stringify({
        to: [{ email: input.recipient }],
        templateId,
        params: input.variables,
        tags: ['go-digital-crm'],
      }),
    });
    const body = (await response.json()) as BrevoResponse;
    if (!response.ok || !body.messageId)
      throw new Error(`BREVO_SEND_FAILED_${body.code ?? response.status}`);
    return { providerMessageId: body.messageId, acceptedAt: new Date().toISOString() };
  }
}
