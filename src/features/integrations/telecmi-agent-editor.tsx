'use client';

import { useMutation } from '@tanstack/react-query';
import { Plus, Trash2, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { provisionTelecmiAgent, type IntegrationScopeMode } from './integration-workspace-api';

export type TelecmiAgentRow = { key: string; user_id: string; phone: string };

export function newTelecmiAgentRow(row?: { user_id: string; phone: string }): TelecmiAgentRow {
  return { key: crypto.randomUUID(), user_id: row?.user_id ?? '', phone: row?.phone ?? '' };
}

/**
 * Editor for the TeleCMI user_id/phone mappings a website call needs.
 *
 * A row can be typed in by hand for an agent that already exists in the TeleCMI
 * dashboard, or created here: provisioning calls TeleCMI's user API and fills
 * the returned `extension_appid` in, which is the field admins most often
 * mistype. The App Secret is only ever forwarded to the Edge Function.
 */
export function TelecmiAgentEditor({
  organizationId,
  scopeMode,
  branchIds,
  appId,
  appSecret,
  rows,
  onChange,
}: {
  organizationId: string;
  scopeMode: IntegrationScopeMode;
  branchIds: string[];
  appId: string;
  appSecret: string;
  rows: TelecmiAgentRow[];
  onChange: (rows: TelecmiAgentRow[]) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ name: '', extension: '', phone: '', password: '' });
  const canProvision =
    Number(appId) > 0 &&
    appSecret.trim().length >= 8 &&
    draft.name.trim().length >= 2 &&
    /^\d{3}$/.test(draft.extension.trim()) &&
    draft.phone.trim().length >= 8 &&
    draft.password.length >= 8;

  const provision = useMutation({
    mutationFn: () =>
      provisionTelecmiAgent({
        organizationId,
        scopeMode,
        branchIds,
        appId: Number(appId),
        appSecret: appSecret.trim(),
        extension: draft.extension.trim(),
        name: draft.name.trim(),
        phone: draft.phone.trim(),
        password: draft.password,
      }),
    onSuccess: (created) => {
      onChange([
        ...rows,
        newTelecmiAgentRow({ user_id: created.user_id, phone: String(created.phone) }),
      ]);
      setDraft({ name: '', extension: '', phone: '', password: '' });
      setCreating(false);
    },
  });

  const updateRow = (key: string, patch: Partial<TelecmiAgentRow>) =>
    onChange(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  return (
    <div className="grid gap-3 sm:col-span-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">Employee mobile mappings</span>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onChange([...rows, newTelecmiAgentRow()])}
          >
            <Plus className="size-4" />
            Add existing
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setCreating((open) => !open)}
          >
            <UserPlus className="size-4" />
            Create in TeleCMI
          </Button>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
          Add at least one mapping. A website call rings the signed-in employee’s exact mapped
          mobile; there is no shared-agent fallback.
        </p>
      ) : null}

      {rows.map((row, index) => (
        <div key={row.key} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <label className="grid gap-1 text-xs font-normal text-muted-foreground">
            {index === 0 ? 'TeleCMI user ID' : null}
            <Input
              value={row.user_id}
              onChange={(event) => updateRow(row.key, { user_id: event.target.value })}
              placeholder="101_2223012"
              pattern="\d{1,12}_\d{1,12}"
              required
              autoComplete="off"
              aria-label={`TeleCMI user ID ${index + 1}`}
            />
          </label>
          <label className="grid gap-1 text-xs font-normal text-muted-foreground">
            {index === 0 ? 'Employee mobile' : null}
            <Input
              value={row.phone}
              onChange={(event) => updateRow(row.key, { phone: event.target.value })}
              placeholder="919876543210"
              required
              autoComplete="off"
              aria-label={`Employee mobile ${index + 1}`}
            />
          </label>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={index === 0 ? 'self-end' : undefined}
            onClick={() => onChange(rows.filter((entry) => entry.key !== row.key))}
            aria-label={`Remove mapping ${index + 1}`}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}

      {creating ? (
        <div className="grid gap-3 rounded-lg border bg-muted/40 p-3 sm:grid-cols-2">
          <p className="text-xs text-muted-foreground sm:col-span-2">
            This creates the user in your TeleCMI account and adds the returned mapping below. Give
            the softphone password to the employee yourself — the CRM never stores it.
          </p>
          <label className="grid gap-1.5 text-sm font-medium">
            Agent name
            <Input
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              maxLength={80}
              autoComplete="off"
            />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Extension
            <Input
              value={draft.extension}
              onChange={(event) => setDraft({ ...draft, extension: event.target.value })}
              placeholder="101"
              inputMode="numeric"
              maxLength={3}
              autoComplete="off"
            />
            <span className="text-xs font-normal text-muted-foreground">
              Three digits. TeleCMI builds the user ID as extension_appid.
            </span>
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Employee mobile
            <Input
              value={draft.phone}
              onChange={(event) => setDraft({ ...draft, phone: event.target.value })}
              placeholder="919876543210"
              autoComplete="off"
            />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Softphone password
            <PasswordInput
              value={draft.password}
              onChange={(event) => setDraft({ ...draft, password: event.target.value })}
              minLength={8}
              maxLength={64}
              autoComplete="new-password"
            />
          </label>
          {provision.isError ? (
            <Alert className="sm:col-span-2">
              <AlertTitle>Agent was not created</AlertTitle>
              <AlertDescription>
                {provision.error instanceof Error
                  ? provision.error.message
                  : 'TeleCMI rejected the request.'}
              </AlertDescription>
            </Alert>
          ) : null}
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!canProvision || provision.isPending}
              onClick={() => provision.mutate()}
            >
              {provision.isPending ? 'Creating…' : 'Create agent'}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
