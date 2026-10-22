'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Star } from 'lucide-react';
import { z } from 'zod';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import { createClient } from '@/lib/supabase/client';
import { invokeIntegrationFunction } from './integration-workspace-api';

const catalogSchema = z.object({
  last_synced_at: z.string().nullable(),
  records: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      language: z.string(),
      category: z.string().nullable(),
      meta_status: z.string(),
      header_text: z.string().nullable(),
      body: z.string(),
      footer_text: z.string().nullable(),
      fields: z.array(z.string()),
      supported: z.boolean(),
      unsupported_reason: z.string().nullable(),
      enabled: z.boolean(),
      removed_from_meta: z.boolean(),
    }),
  ),
});
type CatalogTemplate = z.infer<typeof catalogSchema>['records'][number];

type SyncResult = { synced: number; approved: number; removed: number; truncated: boolean };

async function fetchCatalog(connectionId: string, signal?: AbortSignal) {
  const { data, error } = await createClient()
    .rpc('get_whatsapp_business_template_catalog', { target_connection_id: connectionId })
    .abortSignal(signal ?? AbortSignal.timeout(10_000));
  if (error) throw error;
  return catalogSchema.parse(data);
}

function formatSyncedAt(value: string | null) {
  if (!value) return 'Never synced';
  return `Synced ${new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))}`;
}

function statusVariant(template: CatalogTemplate) {
  if (template.removed_from_meta) return 'secondary' as const;
  if (template.meta_status === 'APPROVED') return 'success' as const;
  if (['REJECTED', 'DISABLED', 'PAUSED'].includes(template.meta_status))
    return 'destructive' as const;
  return 'warning' as const;
}

function blockedReason(template: CatalogTemplate) {
  if (template.removed_from_meta) return 'Deleted in Meta';
  if (template.meta_status !== 'APPROVED')
    return `${template.meta_status.toLowerCase().replaceAll('_', ' ')} in Meta`;
  if (!template.supported) return `Not supported yet: ${template.unsupported_reason}`;
  return null;
}

const reviewSettingSchema = z.object({
  tokens: z.array(z.string()),
  template_id: z.uuid().nullable(),
  variable_map: z.record(z.string(), z.string()),
});

/** `body:1` reads as "Body {{1}}"; Meta numbers fields per component. */
function fieldLabel(field: string) {
  const [part, name] = field.split(':');
  return name ? `${part === 'header' ? 'Header' : 'Body'} {{${name}}}` : field;
}

/**
 * Which template "Send review link" uses in the inbox when Official WhatsApp's
 * 24-hour window is closed. Inside the window the link goes as a normal message.
 */
function ReviewTemplateSetting({
  organizationId,
  connectionId,
  templates,
}: {
  organizationId: string;
  connectionId: string;
  templates: CatalogTemplate[];
}) {
  const queryClient = useQueryClient();
  const queryKey = ['whatsapp-review-template', organizationId, connectionId];
  const setting = useQuery({
    queryKey,
    queryFn: async () => {
      const { data, error } = await createClient().rpc('get_whatsapp_review_template', {
        target_connection_id: connectionId,
      });
      if (error) throw error;
      return reviewSettingSchema.parse(data);
    },
    staleTime: 60_000,
    retry: false,
    meta: { persist: false },
  });
  // Null until the admin edits; until then the saved setting is shown.
  const [draft, setDraft] = useState<{ templateId: string; values: Record<string, string> } | null>(
    null,
  );
  const enabled = templates.filter((template) => template.enabled);
  const current = draft ?? {
    templateId: setting.data?.template_id ?? '',
    values: setting.data?.variable_map ?? {},
  };
  const template = enabled.find((row) => row.id === current.templateId);
  const save = useMutation({
    meta: { toast: false },
    mutationFn: async () => {
      const { error } = await createClient().rpc('set_whatsapp_review_template', {
        target_connection_id: connectionId,
        target_template_id: current.templateId || null,
        target_variable_map: current.values,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setDraft(null);
      void queryClient.invalidateQueries({ queryKey });
      toast.add({ type: 'success', title: 'Review template saved' });
    },
    onError: (error) =>
      toast.add({
        type: 'error',
        title: 'Review template not saved',
        description:
          error instanceof Error && error.message === 'REVIEW_TEMPLATE_FIELD_REQUIRED'
            ? 'Fill in every field of the template.'
            : 'Only a template switched on below can be used. Sync and try again.',
      }),
  });
  // Managers only; a reader without integration.manage sees the list but not this.
  if (setting.isError) return null;
  const complete = !template || template.fields.every((field) => current.values[field]?.trim());
  return (
    <div className="space-y-2 rounded-md border bg-muted/20 p-3">
      <div className="flex items-center gap-2">
        <Star className="size-4 text-amber-500" />
        <p className="text-sm font-medium">Review link template</p>
      </div>
      <p className="text-xs text-muted-foreground">
        Sent by “Send review link” in the inbox when the 24-hour reply window is closed. Use{' '}
        {'{{review_link}}'} in a field to include the customer’s review link.
      </p>
      <Select
        value={current.templateId || 'none'}
        onValueChange={(value) =>
          setDraft({ templateId: value === 'none' ? '' : value, values: {} })
        }
        disabled={setting.isPending || save.isPending}
      >
        <SelectTrigger aria-label="Review link template">
          <SelectValue placeholder="Choose a template" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">None — text only inside the window</SelectItem>
          {enabled.map((row) => (
            <SelectItem key={row.id} value={row.id}>
              {row.name} ({row.language})
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {template?.fields.map((field) => (
        <div className="flex gap-2" key={field}>
          <Input
            aria-label={fieldLabel(field)}
            placeholder={fieldLabel(field)}
            maxLength={500}
            value={current.values[field] ?? ''}
            onChange={(event) =>
              setDraft({ ...current, values: { ...current.values, [field]: event.target.value } })
            }
          />
          <Select
            value=""
            onValueChange={(token) =>
              setDraft({
                ...current,
                values: {
                  ...current.values,
                  [field]: `${current.values[field] ?? ''}{{${token}}}`,
                },
              })
            }
          >
            <SelectTrigger
              className="w-40 shrink-0"
              aria-label={`Insert a field into ${fieldLabel(field)}`}
            >
              <SelectValue placeholder="Insert field" />
            </SelectTrigger>
            <SelectContent>
              {(setting.data?.tokens ?? []).map((token) => (
                <SelectItem key={token} value={token}>
                  {token.replaceAll('_', ' ')}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ))}
      {draft ? (
        <div className="flex justify-end gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setDraft(null)}
            disabled={save.isPending}
          >
            Cancel
          </Button>
          <Button size="sm" onClick={() => save.mutate()} disabled={!complete || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Every message template on the connection's WhatsApp Business Account, with a
 * switch for which approved ones agents may send from the inbox.
 */
export function WhatsAppTemplatesCard({
  organizationId,
  connectionId,
}: {
  organizationId: string;
  connectionId: string;
}) {
  const queryClient = useQueryClient();
  const queryKey = ['whatsapp-template-catalog', organizationId, connectionId];
  const catalog = useQuery({
    queryKey,
    queryFn: ({ signal }) => fetchCatalog(connectionId, signal),
    staleTime: 60_000,
    retry: 1,
    meta: { persist: false },
  });
  const sync = useMutation({
    meta: { toast: false },
    mutationFn: () =>
      invokeIntegrationFunction<SyncResult>('whatsapp-templates-sync', {
        organization_id: organizationId,
        connection_id: connectionId,
      }),
    onSuccess: (result) => {
      toast.add({
        type: 'success',
        title: 'Templates synced from Meta',
        description: `${result.synced} found, ${result.approved} approved${result.removed ? `, ${result.removed} no longer in Meta` : ''}.`,
      });
      void queryClient.invalidateQueries({ queryKey });
    },
  });
  const toggle = useMutation({
    meta: { toast: false },
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      const { error } = await createClient().rpc('set_whatsapp_business_template_enabled', {
        target_template_id: id,
        target_enabled: enabled,
      });
      if (error) throw error;
    },
    onMutate: async ({ id, enabled }) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<z.infer<typeof catalogSchema>>(queryKey);
      queryClient.setQueryData<z.infer<typeof catalogSchema>>(queryKey, (current) =>
        current
          ? {
              ...current,
              records: current.records.map((row) => (row.id === id ? { ...row, enabled } : row)),
            }
          : current,
      );
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(queryKey, context.previous);
      toast.add({
        type: 'error',
        title: 'Template could not be updated',
        description: 'Sync again and retry. Only approved, supported templates can be shown.',
      });
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey }),
  });
  const records = catalog.data?.records ?? [];
  const enabledCount = records.filter((row) => row.enabled).length;

  return (
    <section className="space-y-3 rounded-lg border p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="font-medium">WhatsApp templates</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Templates from this WhatsApp Business Account. Switch on the ones agents can send from
            the inbox to start a chat.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {formatSyncedAt(catalog.data?.last_synced_at ?? null)}
            {records.length ? ` · ${enabledCount} of ${records.length} shown in CRM` : ''}
          </p>
        </div>
        <Button variant="outline" onClick={() => sync.mutate()} disabled={sync.isPending}>
          <RefreshCw className={`size-4 ${sync.isPending ? 'animate-spin' : ''}`} />
          {sync.isPending ? 'Syncing…' : 'Sync from Meta'}
        </Button>
      </div>
      {sync.isError && (
        <Alert variant="destructive">
          <AlertDescription>
            {sync.error instanceof Error ? sync.error.message : 'Templates could not be synced.'}
          </AlertDescription>
        </Alert>
      )}
      {records.length > 0 && (
        <ReviewTemplateSetting
          organizationId={organizationId}
          connectionId={connectionId}
          templates={records}
        />
      )}
      {catalog.isPending ? (
        <p className="text-sm text-muted-foreground">Loading templates…</p>
      ) : catalog.isError ? (
        <div className="text-sm text-muted-foreground">
          Templates could not be loaded.
          <Button size="sm" variant="ghost" onClick={() => void catalog.refetch()}>
            Retry
          </Button>
        </div>
      ) : records.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No templates yet. Press Sync from Meta to load them from WhatsApp Manager.
        </p>
      ) : (
        <ul className="divide-y rounded-md border">
          {records.map((template) => {
            const blocked = blockedReason(template);
            const switchId = `whatsapp-template-${template.id}`;
            return (
              <li key={template.id} className="flex items-start gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <label htmlFor={switchId} className="block truncate text-sm font-medium">
                    {template.name}
                  </label>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <Badge variant={statusVariant(template)}>
                      {template.removed_from_meta ? 'Deleted' : template.meta_status}
                    </Badge>
                    <Badge variant="secondary">{template.language}</Badge>
                    {template.category && (
                      <Badge variant="secondary">{template.category.toLowerCase()}</Badge>
                    )}
                    {template.fields.length > 0 && (
                      <span className="text-[11px] text-muted-foreground">
                        {template.fields.length} field{template.fields.length === 1 ? '' : 's'}
                      </span>
                    )}
                  </div>
                  <p className="mt-1.5 line-clamp-2 whitespace-pre-wrap text-xs text-muted-foreground">
                    {[template.header_text, template.body].filter(Boolean).join(' — ')}
                  </p>
                  {blocked && <p className="mt-1 text-[11px] text-amber-700">{blocked}</p>}
                </div>
                <Switch
                  id={switchId}
                  checked={template.enabled}
                  disabled={Boolean(blocked) || toggle.isPending}
                  aria-label={`Show ${template.name} in the CRM inbox`}
                  onCheckedChange={(enabled) => toggle.mutate({ id: template.id, enabled })}
                />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
