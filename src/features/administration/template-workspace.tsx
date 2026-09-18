'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  Ban,
  BadgeCheck,
  FileText,
  Mail,
  MessageCircle,
  Plus,
  Search,
  Smartphone,
} from 'lucide-react';
import { useState } from 'react';
import {
  useWorkspaceSession,
  workspaceQueryScope,
} from '@/components/providers/workspace-session-provider';
import { KpiGrid } from '@/components/shared/kpi-grid';
import { PageHeader } from '@/components/shared/page-header';
import { TemplateWorkspaceSkeleton } from '@/components/skeletons';
import { StatusBadge } from '@/components/shared/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import type { Metric, PageSpec } from '@/lib/domain';
import {
  approveTemplate,
  archiveTemplate,
  createDraftTemplate,
  fetchTemplateWorkspace,
  rejectTemplate,
  savePersonalWhatsAppTemplate,
  type TemplateRecord,
  type TemplateWorkspaceQuery,
} from './template-workspace-api';

const channels = ['EMAIL', 'SMS', 'WHATSAPP', 'WHATSAPP_BUSINESS', 'WHATSAPP_PERSONAL'] as const;
function channelLabel(channel: string) {
  return channel === 'WHATSAPP_PERSONAL' ? 'My WhatsApp' : channel.replaceAll('_', ' ');
}
function iconForChannel(channel: string) {
  return channel === 'EMAIL' ? Mail : channel === 'SMS' ? Smartphone : MessageCircle;
}
function formatDate(value: string) {
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}
function bodyOf(value: Record<string, unknown>) {
  const body = value.body;
  return typeof body === 'string' ? body : 'Structured template content';
}

function CreateTemplateDialog({
  onClose,
  template,
}: {
  onClose: () => void;
  template?: TemplateRecord;
}) {
  const client = useQueryClient();
  const [channel, setChannel] = useState(template?.channel ?? 'EMAIL');
  const personal = channel === 'WHATSAPP_PERSONAL';
  const create = useMutation({
    mutationFn: (input: Parameters<typeof createDraftTemplate>[0]) =>
      template
        ? savePersonalWhatsAppTemplate({ ...input, templateId: template.id })
        : createDraftTemplate(input),
    onSuccess: () => {
      toast.add({
        type: 'success',
        title: personal ? 'Saved reply ready' : 'Template draft created',
        description: personal
          ? 'Staff can select this text in their My WhatsApp inbox.'
          : 'It remains a draft until its provider approval state is confirmed.',
      });
      client.invalidateQueries({ queryKey: ['template-workspace'] });
      client.invalidateQueries({ queryKey: ['personal-whatsapp-templates'] });
      onClose();
    },
    onError: () =>
      toast.add({
        type: 'error',
        title: 'Template was not created',
        description: 'Check the values and your administrator access.',
      }),
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{template ? 'Edit saved reply' : 'Create template'}</DialogTitle>
          <DialogDescription>
            {personal
              ? 'Save reusable plain text for My WhatsApp. Staff review and send each reply within the existing reply window.'
              : 'Drafts are safe to prepare here. Provider approval is intentionally not implied.'}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            create.mutate({
              name: String(form.get('name') ?? ''),
              channel: channel as (typeof channels)[number],
              body: String(form.get('body') ?? ''),
              requestId: globalThis.crypto.randomUUID(),
            });
          }}
        >
          <label className="grid gap-1.5 text-sm font-medium">
            Template name
            <Input
              name="name"
              defaultValue={template?.name}
              required
              minLength={2}
              maxLength={120}
              placeholder="New-lead welcome"
            />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Channel
            <Select
              name="channel"
              value={channel}
              onValueChange={setChannel}
              disabled={Boolean(template)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {channels.map((channel) => (
                  <SelectItem key={channel} value={channel}>
                    {channelLabel(channel)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Message body
            <Textarea
              name="body"
              defaultValue={template ? bodyOf(template.content) : undefined}
              required
              minLength={1}
              maxLength={personal ? 1500 : 5000}
              rows={7}
              placeholder={
                personal
                  ? 'Hello! Thank you for your enquiry. How can I help you today?'
                  : 'Hello {{customer_name}}, welcome to…'
              }
            />
          </label>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={create.isPending}>
              {create.isPending ? 'Saving…' : personal ? 'Save reply' : 'Save draft'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Brevo identifies a template by a numeric id; Meta identifies one by the
// lowercase snake-case name it approved. Both are rejected server-side when they
// do not match, so the hint here is what stops an admin from discovering the rule
// through a failed send days later.
function providerIdRules(channel: string) {
  if (channel === 'EMAIL')
    return {
      label: 'Brevo template ID',
      placeholder: '42',
      pattern: '[0-9]{1,18}',
      hint: 'The numeric ID shown on the template in Brevo.',
    };
  if (channel === 'SMS')
    return {
      label: 'Provider template ID',
      placeholder: 'sms_welcome_v1',
      pattern: '.{1,512}',
      hint: 'The ID your SMS provider issued for this approved template.',
    };
  return {
    label: 'Meta template name',
    placeholder: 'new_lead_welcome',
    pattern: '[a-z0-9_]{1,512}',
    hint: 'Lowercase letters, numbers and underscores, exactly as approved in Meta.',
  };
}

function RejectTemplateDialog({
  template,
  onClose,
}: {
  template: TemplateRecord;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const reject = useMutation({
    mutationFn: rejectTemplate,
    onSuccess: () => {
      toast.add({
        type: 'success',
        title: 'Template rejected',
        description: 'Its provider ID is cleared so a replacement can reuse it.',
      });
      client.invalidateQueries({ queryKey: ['template-workspace'] });
      onClose();
    },
    onError: () =>
      toast.add({
        type: 'error',
        title: 'Template was not rejected',
        description: 'Try again or check administrator access.',
      }),
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reject template</DialogTitle>
          <DialogDescription>
            The template stays visible for audit and its provider ID is released.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            reject.mutate({
              templateId: template.id,
              reason: String(form.get('reason') ?? ''),
              requestId: globalThis.crypto.randomUUID(),
            });
          }}
        >
          <label className="grid gap-1.5 text-sm font-medium">
            Reason
            <Textarea
              name="reason"
              required
              minLength={3}
              maxLength={500}
              rows={4}
              placeholder="Meta rejected this template for policy reasons."
            />
          </label>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={reject.isPending}>
              {reject.isPending ? 'Rejecting…' : 'Reject template'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ApproveTemplateDialog({
  template,
  onClose,
}: {
  template: TemplateRecord;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const rules = providerIdRules(template.channel.toUpperCase());
  const approve = useMutation({
    mutationFn: approveTemplate,
    onSuccess: (result) => {
      toast.add({
        type: 'success',
        title: result.replayed ? 'Template already approved' : 'Template approved',
        description: `Sending can now use ${result.provider_template_id}.`,
      });
      client.invalidateQueries({ queryKey: ['template-workspace'] });
      onClose();
    },
    onError: (error: { message?: string }) =>
      toast.add({
        type: 'error',
        title: 'Template was not approved',
        description: error?.message?.includes('IN_USE')
          ? 'Another approved template already uses that provider ID.'
          : 'Check the provider ID format and your administrator access.',
      }),
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record provider approval</DialogTitle>
          <DialogDescription>
            Approve the template in {template.channel.toUpperCase() === 'EMAIL' ? 'Brevo' : 'Meta'}{' '}
            first, then record the ID it issued. This does not request approval.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            approve.mutate({
              templateId: template.id,
              providerTemplateId: String(form.get('provider_template_id') ?? ''),
              requestId: globalThis.crypto.randomUUID(),
            });
          }}
        >
          <div className="rounded-md border bg-muted/40 p-3 text-sm">
            <p className="font-medium">{template.name}</p>
            <p className="text-xs text-muted-foreground">{template.channel.replaceAll('_', ' ')}</p>
          </div>
          <label className="grid gap-1.5 text-sm font-medium">
            {rules.label}
            <Input
              name="provider_template_id"
              required
              maxLength={512}
              pattern={rules.pattern}
              placeholder={rules.placeholder}
              defaultValue={template.provider_template_id ?? ''}
            />
            <span className="text-xs font-normal text-muted-foreground">{rules.hint}</span>
          </label>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={approve.isPending}>
              {approve.isPending ? 'Recording…' : 'Record approval'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function TemplateWorkspace({ spec }: { spec: PageSpec }) {
  const session = useWorkspaceSession();
  const [query, setQuery] = useState<TemplateWorkspaceQuery>({
    page: 1,
    pageSize: 25,
    search: '',
    channel: 'ALL',
    status: 'ALL',
  });
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<TemplateRecord | null>(null);
  const [approving, setApproving] = useState<TemplateRecord | null>(null);
  const [rejecting, setRejecting] = useState<TemplateRecord | null>(null);
  const client = useQueryClient();
  const workspace = useQuery({
    queryKey: ['template-workspace', ...workspaceQueryScope(session), query],
    queryFn: () => fetchTemplateWorkspace(query),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
  const archive = useMutation({
    mutationFn: archiveTemplate,
    onSuccess: () => {
      toast.add({
        type: 'success',
        title: 'Template archived',
        description: 'The template is preserved for audit and removed from active selection.',
      });
      client.invalidateQueries({ queryKey: ['template-workspace'] });
      client.invalidateQueries({ queryKey: ['personal-whatsapp-templates'] });
    },
    onError: () =>
      toast.add({
        type: 'error',
        title: 'Template was not archived',
        description: 'Try again or check administrator access.',
      }),
  });
  if (workspace.isPending) return <TemplateWorkspaceSkeleton />;
  if (workspace.isError || !workspace.data)
    return (
      <div className="space-y-5">
        <PageHeader spec={{ ...spec, primaryAction: undefined }} />
        <Alert>
          <AlertTitle>Templates are unavailable</AlertTitle>
          <AlertDescription>
            Confirm template-management permission and deploy its workspace migration.
          </AlertDescription>
        </Alert>
      </div>
    );
  const { kpis, records, total } = workspace.data;
  const metrics: Metric[] = [
    { label: 'All templates', value: String(kpis.total), icon: FileText },
    { label: 'Drafts', value: String(kpis.draft), icon: FileText },
    { label: 'Provider approved', value: String(kpis.approved), icon: MessageCircle },
    {
      label: 'Needs attention',
      value: String(kpis.attention),
      icon: Archive,
      trend: kpis.attention ? 'down' : 'neutral',
    },
  ];
  const pages = Math.max(1, Math.ceil(total / query.pageSize));
  return (
    <div className="mx-auto max-w-[1800px] space-y-5">
      <div className="flex flex-wrap justify-between gap-3">
        <PageHeader spec={{ ...spec, primaryAction: undefined }} />
        <Button onClick={() => setOpen(true)}>
          <Plus /> Create template
        </Button>
      </div>
      <KpiGrid metrics={metrics} className="xl:grid-cols-4" />
      <Card className="shadow-none">
        <CardHeader className="border-b p-4">
          <div className="flex flex-wrap gap-3">
            <div className="relative min-w-0 flex-1">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-9"
                value={query.search}
                onChange={(event) =>
                  setQuery((current) => ({ ...current, page: 1, search: event.target.value }))
                }
                placeholder="Search template name or provider ID"
              />
            </div>
            <Select
              value={query.channel}
              onValueChange={(value) =>
                setQuery((current) => ({
                  ...current,
                  page: 1,
                  channel: value as TemplateWorkspaceQuery['channel'],
                }))
              }
            >
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All channels</SelectItem>
                {channels.map((channel) => (
                  <SelectItem key={channel} value={channel}>
                    {channelLabel(channel)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={query.status}
              onValueChange={(value) =>
                setQuery((current) => ({
                  ...current,
                  page: 1,
                  status: value as TemplateWorkspaceQuery['status'],
                }))
              }
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {['ALL', 'ACTIVE', 'DRAFT', 'APPROVED', 'REJECTED'].map((status) => (
                  <SelectItem key={status} value={status}>
                    {status === 'ALL' ? 'All statuses' : status}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Template</TableHead>
                <TableHead>Channel</TableHead>
                <TableHead>Preview</TableHead>
                <TableHead>Provider template</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {records.length ? (
                records.map((item) => {
                  const Icon = iconForChannel(item.channel);
                  return (
                    <TableRow key={item.id}>
                      <TableCell>
                        <p className="font-medium">{item.name}</p>
                        <p className="text-xs text-muted-foreground">{item.created_by_name}</p>
                      </TableCell>
                      <TableCell>
                        <span className="flex items-center gap-2">
                          <Icon className="size-4 text-blue-600" />
                          {channelLabel(item.channel)}
                        </span>
                      </TableCell>
                      <TableCell className="max-w-72 truncate">{bodyOf(item.content)}</TableCell>
                      <TableCell>
                        {item.channel === 'WHATSAPP_PERSONAL'
                          ? 'Saved text reply'
                          : (item.provider_template_id ?? 'Not submitted')}
                      </TableCell>
                      <TableCell>
                        <StatusBadge value={item.status} />
                      </TableCell>
                      <TableCell>{formatDate(item.updated_at)}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          {item.channel === 'WHATSAPP_PERSONAL' && (
                            <Button size="sm" variant="outline" onClick={() => setEditing(item)}>
                              Edit
                            </Button>
                          )}
                          {['DRAFT', 'REJECTED'].includes(item.status.toUpperCase()) && (
                            <Button size="sm" onClick={() => setApproving(item)}>
                              <BadgeCheck /> Approve
                            </Button>
                          )}
                          {['DRAFT', 'APPROVED'].includes(item.status.toUpperCase()) && (
                            <Button size="sm" variant="outline" onClick={() => setRejecting(item)}>
                              <Ban /> Reject
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={archive.isPending}
                            onClick={() => archive.mutate(item.id)}
                          >
                            <Archive /> Archive
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              ) : (
                <TableRow>
                  <TableCell colSpan={7} className="h-28 text-center text-muted-foreground">
                    No templates match this view.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
        <div className="flex items-center justify-between border-t p-3 text-sm text-muted-foreground">
          <span>{total} templates</span>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={query.page <= 1}
              onClick={() => setQuery((current) => ({ ...current, page: current.page - 1 }))}
            >
              Previous
            </Button>
            <span>
              Page {query.page} / {pages}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={query.page >= pages}
              onClick={() => setQuery((current) => ({ ...current, page: current.page + 1 }))}
            >
              Next
            </Button>
          </div>
        </div>
      </Card>
      {open && <CreateTemplateDialog onClose={() => setOpen(false)} />}
      {editing && <CreateTemplateDialog template={editing} onClose={() => setEditing(null)} />}
      {approving && (
        <ApproveTemplateDialog template={approving} onClose={() => setApproving(null)} />
      )}
      {rejecting && (
        <RejectTemplateDialog template={rejecting} onClose={() => setRejecting(null)} />
      )}
    </div>
  );
}
