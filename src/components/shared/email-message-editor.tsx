'use client';

import { useId } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';

const sampleValues: Record<string, string> = {
  customer_name: 'Aarav Sharma',
  customer_first_name: 'Aarav',
  first_name: 'Aarav',
  name: 'Aarav Sharma',
  branch_name: 'Your Dealership',
  branch_phone: '+91 98765 43210',
  lead_source: 'Website',
  interested_model: 'Your preferred model',
  vehicle_model: 'Your preferred model',
  consultant_name: 'Your Sales Consultant',
  booking_number: 'BK-001',
  delivery_date: '20 October 2026',
};

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character];
  });
}

function textToHtml(value: string) {
  const paragraphs = value
    .trim()
    .split(/\r?\n\s*\r?\n/)
    .map(
      (paragraph) =>
        `<p style="margin:0 0 16px">${escapeHtml(paragraph).replace(/\r?\n/g, '<br>')}</p>`,
    )
    .join('\n');
  return `<div style="max-width:600px;margin:0 auto;padding:24px;background:#ffffff;color:#1f2937;font-family:Arial,sans-serif;font-size:14px;line-height:1.6">\n${paragraphs}\n</div>`;
}

export function EmailMessageEditor({
  value,
  onChange,
  variableMap = {},
  literalVariables = false,
  disabled = false,
  ariaLabel = 'Email message',
}: {
  value: string;
  onChange: (value: string) => void;
  variableMap?: Record<string, string>;
  literalVariables?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const id = useId();
  const hasHtml = /<\/?[a-z][a-z0-9-]*(?:\s[^>]*|\/?)>/i.test(value);
  const converted = textToHtml(value);
  const previewBody = (hasHtml ? value : converted).replace(
    /\{\{\s*([A-Za-z0-9_]{1,40})\s*\}\}/g,
    (placeholder, name: string) => {
      const mapped = Object.hasOwn(variableMap, name) ? variableMap[name] : undefined;
      const sampleKey = (mapped || name).toLowerCase();
      const replacement = literalVariables
        ? mapped
        : Object.hasOwn(sampleValues, sampleKey)
          ? sampleValues[sampleKey]
          : undefined;
      return replacement ? escapeHtml(replacement) : placeholder;
    },
  );
  // The iframe has no script or same-origin permission. CSP also blocks forms,
  // nested frames and network calls while allowing email styles and images.
  const preview = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; form-action 'none'; base-uri 'none'"><meta name="viewport" content="width=device-width, initial-scale=1"><style>html{color-scheme:light}body{margin:0;background:#ffffff;overflow-wrap:anywhere}img{max-width:100%;height:auto}</style></head><body>${previewBody}</body></html>`;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label htmlFor={id} className="text-sm font-medium">
          Message (HTML)
        </label>
        {!hasHtml && value.trim() && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || converted.length > 4000}
            title={
              converted.length > 4000
                ? 'Shorten the message before converting it to HTML (4,000 character limit).'
                : undefined
            }
            onClick={() => onChange(converted)}
          >
            Convert text to HTML
          </Button>
        )}
      </div>
      <Textarea
        id={id}
        aria-label={ariaLabel}
        aria-describedby={`${id}-help`}
        value={value}
        rows={8}
        maxLength={4000}
        disabled={disabled}
        spellCheck={false}
        className="font-mono text-xs leading-relaxed"
        placeholder={'<p>Hi {{FIRST_NAME}},</p>\n<p>Thank you for your enquiry.</p>'}
        onChange={(event) => onChange(event.target.value)}
      />
      <p id={`${id}-help`} className="text-xs text-muted-foreground">
        Write or paste HTML. Use {'{{NAME}}'} for a variable. Edited text creates a draft template
        and needs provider approval.
      </p>
      <Card className="gap-0 overflow-hidden py-0 shadow-none">
        <CardHeader className="gap-1 border-b bg-muted/30 px-4 py-3">
          <p className="text-sm font-medium">Live email preview</p>
          <p className="text-xs text-muted-foreground">
            Updates as you type. Variables use{' '}
            {literalVariables ? 'the values below' : 'sample values'}. Email apps may display
            formatting differently.
          </p>
        </CardHeader>
        <CardContent className="bg-white p-0">
          {value.trim() ? (
            <iframe
              title={`${ariaLabel} live preview`}
              srcDoc={preview}
              sandbox=""
              referrerPolicy="no-referrer"
              className="block h-80 w-full border-0"
            />
          ) : (
            <p className="px-4 py-12 text-center text-sm text-muted-foreground">
              Write a message to see the email preview here.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
