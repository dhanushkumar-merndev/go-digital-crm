'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FilePenLine, LoaderCircle, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import {
  createSocialPostDraft,
  fetchSocialPostDraftOptions,
  type SocialPostPlatform,
} from './social-post-draft-api';

const platformOptions: Array<{ value: SocialPostPlatform; label: string }> = [
  { value: 'FACEBOOK', label: 'Facebook' },
  { value: 'INSTAGRAM', label: 'Instagram' },
  { value: 'GOOGLE_BUSINESS_PROFILE', label: 'Google Business Profile' },
  { value: 'OTHER', label: 'Other approved channel' },
];

function newRequestId() {
  return globalThis.crypto.randomUUID();
}

export function SocialPostDraftAction() {
  const [open, setOpen] = useState(false);
  const options = useQuery({
    queryKey: ['social-post-draft-options'],
    queryFn: ({ signal }) => fetchSocialPostDraftOptions(signal),
    staleTime: 5 * 60_000,
  });
  if (options.isPending || options.isError || !options.data) return null;
  return <SocialPostDraftDialog options={options.data} open={open} onOpenChange={setOpen} />;
}

function SocialPostDraftDialog({
  options,
  open,
  onOpenChange,
}: {
  options: Awaited<ReturnType<typeof fetchSocialPostDraftOptions>>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [platform, setPlatform] = useState<SocialPostPlatform>('FACEBOOK');
  const [content, setContent] = useState('');
  const defaultScope = options.can_use_organization_scope
    ? 'organization'
    : (options.branches[0]?.id ?? '');
  const [scopeValue, setScopeValue] = useState(defaultScope);
  const [requestId, setRequestId] = useState(newRequestId);
  const effectiveScope = scopeValue || defaultScope;
  const mutation = useMutation({
    mutationFn: () =>
      createSocialPostDraft({
        platform,
        content: content.trim(),
        branchId: effectiveScope === 'organization' ? null : effectiveScope,
        requestId,
      }),
    onSuccess: () => {
      toast.add({
        type: 'success',
        title: 'Draft saved',
        description: 'The post is stored as a CRM draft and has not been sent to a provider.',
      });
      void queryClient.invalidateQueries({ queryKey: ['marketing-workspace'] });
      void queryClient.invalidateQueries({ queryKey: ['social-content-calendar'] });
      setContent('');
      setRequestId(newRequestId());
      onOpenChange(false);
    },
    onError: () =>
      toast.add({
        type: 'error',
        title: 'Draft could not be saved',
        description: 'Check the selected scope and try again.',
      }),
  });

  const hasScope = Boolean(effectiveScope);
  const canSave = content.trim().length > 0 && content.trim().length <= 5000 && hasScope;

  return (
    <>
      <Button onClick={() => onOpenChange(true)}>
        <Plus className="size-4" /> Create post draft
      </Button>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FilePenLine className="size-5 text-blue-600" /> Create social post draft
            </DialogTitle>
            <DialogDescription>
              Save content for review. Publishing and scheduling require a connected provider
              workflow.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (canSave) mutation.mutate();
            }}
          >
            <label className="grid gap-1.5 text-sm font-medium">
              Channel
              <Select
                value={platform}
                onValueChange={(value) => setPlatform(value as SocialPostPlatform)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {platformOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              Scope
              <Select value={scopeValue} onValueChange={setScopeValue}>
                <SelectTrigger>
                  <SelectValue placeholder="Select an authorized scope" />
                </SelectTrigger>
                <SelectContent>
                  {options.can_use_organization_scope ? (
                    <SelectItem value="organization">Organization-wide</SelectItem>
                  ) : null}
                  {options.branches.map((branch) => (
                    <SelectItem key={branch.id} value={branch.id}>
                      {branch.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              Post content
              <Textarea
                value={content}
                onChange={(event) => setContent(event.target.value)}
                maxLength={5000}
                className="min-h-40 resize-y"
                placeholder="Write the approved message for your customer audience…"
              />
              <span className="text-right text-xs font-normal text-muted-foreground">
                {content.length.toLocaleString()} / 5,000
              </span>
            </label>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!canSave || mutation.isPending}>
                {mutation.isPending ? <LoaderCircle className="size-4 animate-spin" /> : null}
                Save draft
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
