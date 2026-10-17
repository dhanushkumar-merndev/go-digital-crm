'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, ImageUp, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import type { BranchAdministrationRecord } from './branch-team-api';
import {
  branchBrandingErrorMessage,
  branchFeedbackBrandingKey,
  branchLogoMimeTypes,
  branchLogoPreviewKey,
  fetchBranchFeedbackBranding,
  fetchBranchLogoPreview,
  saveBranchFeedbackBranding,
  uploadBranchLogo,
  validateBranchLogo,
  type BranchFeedbackBranding,
  type BranchLogoAction,
} from './branch-feedback-branding-api';

const hexPattern = /^#[0-9a-f]{6}$/;
const DEFAULT_SWATCH = '#17233d';

export function BranchFeedbackBrandingDialog({
  branch,
  organizationId,
  open,
  onOpenChange,
  onSaved,
}: {
  branch: BranchAdministrationRecord;
  organizationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const branding = useQuery({
    queryKey: branchFeedbackBrandingKey(branch.id),
    queryFn: () => fetchBranchFeedbackBranding(branch.id),
    staleTime: 0,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{branch.name} feedback page</DialogTitle>
          <DialogDescription>
            The logo and colour customers see when they open this showroom&apos;s feedback link.
          </DialogDescription>
        </DialogHeader>
        {branding.isPending ? (
          <div className="space-y-3">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : branding.isError ? (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <div className="space-y-2">
              <p>The feedback page settings could not be loaded.</p>
              <Button size="sm" variant="outline" onClick={() => void branding.refetch()}>
                Retry
              </Button>
            </div>
          </div>
        ) : (
          <BrandingForm
            key={branding.data.version}
            current={branding.data}
            organizationId={organizationId}
            onCancel={() => onOpenChange(false)}
            onSaved={() => {
              onSaved();
              onOpenChange(false);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function BrandingForm({
  current,
  organizationId,
  onCancel,
  onSaved,
}: {
  current: BranchFeedbackBranding;
  organizationId: string;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const [color, setColor] = useState(current.brand_color ?? '');
  const [logoAction, setLogoAction] = useState<BranchLogoAction>('KEEP');
  const [chosen, setChosen] = useState<{ file: File; previewUrl: string } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const previewRef = useRef<string | null>(null);
  const file = chosen?.file ?? null;

  const storedPreview = useQuery({
    queryKey: branchLogoPreviewKey(current.logo_object_file_id),
    queryFn: () => fetchBranchLogoPreview(current.logo_object_file_id!),
    enabled: Boolean(current.logo_object_file_id),
    staleTime: 4 * 60_000,
    retry: false,
  });

  // Object URLs are revoked when replaced and when the dialog closes.
  const choose = (next: File | null) => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = next ? URL.createObjectURL(next) : null;
    setChosen(next && previewRef.current ? { file: next, previewUrl: previewRef.current } : null);
  };
  useEffect(
    () => () => {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    },
    [],
  );

  const normalizedColor = color.trim().toLowerCase();
  const colorValid = normalizedColor === '' || hexPattern.test(normalizedColor);

  const save = useMutation({
    mutationFn: async () => {
      const logoObjectFileId =
        logoAction === 'REPLACE' && file ? await uploadBranchLogo({ organizationId, file }) : null;
      return saveBranchFeedbackBranding({
        branchId: current.branch_id,
        expectedVersion: current.version,
        brandColor: normalizedColor || null,
        logoAction,
        logoObjectFileId,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: branchFeedbackBrandingKey(current.branch_id),
      });
      onSaved();
    },
  });

  const previewUrl =
    logoAction === 'REPLACE'
      ? (chosen?.previewUrl ?? null)
      : logoAction === 'REMOVE'
        ? null
        : (storedPreview.data ?? null);
  const swatch = colorValid && normalizedColor ? normalizedColor : DEFAULT_SWATCH;

  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!colorValid || (logoAction === 'REPLACE' && !file)) return;
        save.mutate();
      }}
    >
      <div className="space-y-2">
        <Label>Logo</Label>
        <div className="flex items-center gap-4">
          <div className="grid h-16 w-32 place-items-center rounded-md border bg-muted/30">
            {previewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- presigned or local object URL
              <img
                src={previewUrl}
                alt="Logo preview"
                className="max-h-14 max-w-28 object-contain"
              />
            ) : storedPreview.isFetching && logoAction === 'KEEP' ? (
              <Skeleton className="h-10 w-24" />
            ) : (
              <span className="text-xs text-muted-foreground">No logo</span>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" asChild>
              <label className="cursor-pointer">
                <ImageUp className="size-4" />
                {current.logo_object_file_id ? 'Replace' : 'Upload'}
                <input
                  type="file"
                  className="sr-only"
                  accept={branchLogoMimeTypes.join(',')}
                  onChange={(event) => {
                    const picked = event.currentTarget.files?.[0] ?? null;
                    event.currentTarget.value = '';
                    if (!picked) return;
                    try {
                      validateBranchLogo(picked);
                      choose(picked);
                      setLogoAction('REPLACE');
                      setFileError(null);
                    } catch (error) {
                      setFileError(branchBrandingErrorMessage(error));
                    }
                  }}
                />
              </label>
            </Button>
            {(current.logo_object_file_id || logoAction === 'REPLACE') &&
            logoAction !== 'REMOVE' ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  choose(null);
                  setLogoAction(current.logo_object_file_id ? 'REMOVE' : 'KEEP');
                }}
              >
                Remove
              </Button>
            ) : null}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">PNG, JPG or WebP, 2 MB or less.</p>
        {fileError ? <p className="text-xs text-destructive">{fileError}</p> : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="feedback-brand-color">Brand colour</Label>
        <div className="flex items-center gap-2">
          <input
            type="color"
            aria-label="Pick brand colour"
            value={swatch}
            onChange={(event) => setColor(event.currentTarget.value)}
            className="h-9 w-12 cursor-pointer rounded-md border bg-background p-1"
          />
          <Input
            id="feedback-brand-color"
            value={color}
            onChange={(event) => setColor(event.currentTarget.value)}
            placeholder="#17233d"
            maxLength={7}
            className="w-32 font-mono"
            aria-invalid={!colorValid}
          />
          {color ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => setColor('')}>
              Use default
            </Button>
          ) : null}
        </div>
        {!colorValid ? (
          <p className="text-xs text-destructive">Use the #RRGGBB form, for example #1d4ed8.</p>
        ) : null}
      </div>

      <div className="space-y-1.5 rounded-md border p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium">Google review link</p>
          <Badge variant={current.google_review_url ? 'success' : 'secondary'}>
            {current.google_review_url ? 'Set' : 'Not set'}
          </Badge>
        </div>
        {current.google_review_url ? (
          <a
            href={current.google_review_url}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex max-w-full items-center gap-1 truncate text-xs text-primary underline-offset-2 hover:underline"
          >
            <span className="truncate">{current.google_review_url}</span>
            <ExternalLink className="size-3 shrink-0" />
          </a>
        ) : (
          <p className="text-xs text-muted-foreground">
            Filled automatically when a Google Business Profile location is mapped to this branch in
            Integrations.
          </p>
        )}
      </div>

      {save.isError ? (
        <p className="flex items-start gap-2 text-sm text-destructive">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          {branchBrandingErrorMessage(save.error)}
        </p>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={save.isPending}>
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={
            save.isPending ||
            !colorValid ||
            (logoAction === 'REPLACE' && !file) ||
            (logoAction === 'KEEP' && normalizedColor === (current.brand_color ?? ''))
          }
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </DialogFooter>
    </form>
  );
}
