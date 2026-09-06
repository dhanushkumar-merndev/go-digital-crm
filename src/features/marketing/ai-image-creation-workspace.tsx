'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ImagePlus, LoaderCircle, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/components/shared/page-header';
import { AiImageCreationSkeleton } from '@/components/skeletons';
import { StatusBadge } from '@/components/shared/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import type { PageSpec } from '@/lib/domain';
import {
  aiImagePromptSettingsKey,
  fetchAiImagePromptSettings,
  fetchAiImageWorkspace,
  getAiImageUrl,
  queueAiImage,
  saveAiImagePromptSettings,
  saveAiImageAsAsset,
} from './ai-image-creation-api';

/**
 * The three parts the worker assembles around every request. They are edited
 * here rather than baked into the worker so a dealership can state how its
 * posters should look and what must never appear in one.
 */
function PromptSettingsCard() {
  const client = useQueryClient();
  const settings = useQuery({
    queryKey: aiImagePromptSettingsKey,
    queryFn: fetchAiImagePromptSettings,
    staleTime: 300_000,
  });
  const save = useMutation({
    mutationFn: saveAiImagePromptSettings,
    onSuccess: () => {
      toast.add({
        type: 'success',
        title: 'Prompt guidance saved',
        description: 'It applies to the next image generated.',
      });
      void client.invalidateQueries({ queryKey: aiImagePromptSettingsKey });
    },
    onError: () =>
      toast.add({
        type: 'error',
        title: 'Guidance was not saved',
        description: 'Confirm marketing access, then try again.',
      }),
  });
  if (settings.isPending || settings.isError) return null;
  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle className="text-base">Prompt guidance</CardTitle>
        <CardDescription>
          Applied to every generation. The policy is added last, after the operator&apos;s own
          prompt, so a prompt cannot override it.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            save.mutate({
              systemPrompt: String(form.get('system_prompt') ?? ''),
              posterGuide: String(form.get('poster_guide') ?? ''),
              imagePolicy: String(form.get('image_policy') ?? ''),
            });
          }}
        >
          <label className="grid gap-1.5 text-sm font-medium">
            System prompt
            <Textarea
              name="system_prompt"
              rows={3}
              maxLength={4000}
              defaultValue={settings.data.system_prompt}
              placeholder="Produce a polished automobile-dealership marketing visual."
            />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Poster guide
            <Textarea
              name="poster_guide"
              rows={3}
              maxLength={4000}
              defaultValue={settings.data.poster_guide}
              placeholder="Leave the upper third clear for a headline. Keep the vehicle centred."
            />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Image policy
            <Textarea
              name="image_policy"
              rows={3}
              maxLength={4000}
              defaultValue={settings.data.image_policy}
              placeholder="Never show competitor badges, number plates, pricing, or invented text."
            />
            <span className="text-xs font-normal text-muted-foreground">
              Write it as prohibitions. Applied to posters and every other template alike.
            </span>
          </label>
          <div className="flex justify-end">
            <Button size="sm" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save guidance'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/**
 * Names a generated image so it can be found again. The library points at the
 * stored file rather than copying it, so this is metadata only.
 */
function SaveAssetDialog({ objectFileId, onClose }: { objectFileId: string; onClose: () => void }) {
  const save = useMutation({
    mutationFn: saveAiImageAsAsset,
    onSuccess: (result) => {
      toast.add({
        type: 'success',
        title: result.replayed ? 'Already in the library' : 'Saved to library',
        description: `${result.name} can now be reused in a campaign.`,
      });
      onClose();
    },
    onError: () =>
      toast.add({
        type: 'error',
        title: 'Asset was not saved',
        description: 'The image must belong to a completed generation in this organisation.',
      }),
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save to asset library</DialogTitle>
          <DialogDescription>
            Naming it here is what makes it findable for a later campaign.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            save.mutate({
              objectFileId,
              name: String(form.get('name') ?? ''),
              tags: String(form.get('tags') ?? '')
                .split(',')
                .map((tag) => tag.trim())
                .filter(Boolean)
                .slice(0, 20),
            });
          }}
        >
          <label className="grid gap-1.5 text-sm font-medium">
            Asset name
            <Input
              name="name"
              required
              minLength={2}
              maxLength={180}
              placeholder="Diwali offer poster"
            />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Tags
            <Input name="tags" maxLength={400} placeholder="diwali, offer, suv" />
            <span className="text-xs font-normal text-muted-foreground">
              Comma separated, up to 20. Stored lowercase.
            </span>
          </label>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save asset'}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function AiImageCreationWorkspace({ spec }: { spec: PageSpec }) {
  const client = useQueryClient();
  const workspace = useQuery({
    queryKey: ['ai-image-creation'],
    queryFn: fetchAiImageWorkspace,
    refetchInterval: 8_000,
    staleTime: 5_000,
  });
  const [connectionId, setConnectionId] = useState('');
  const [savingAsset, setSavingAsset] = useState<string | null>(null);
  const [template, setTemplate] = useState('SOCIAL_POST');
  const [style, setStyle] = useState('REALISTIC');
  const [ratio, setRatio] = useState('1:1');
  const [count, setCount] = useState('1');
  const selected = connectionId || workspace.data?.connections[0]?.id || '';
  const queue = useMutation({
    mutationFn: (form: FormData) =>
      queueAiImage({
        organization_id: workspace.data?.organization_id,
        connection_id: selected,
        prompt: String(form.get('prompt') ?? ''),
        template_key: template,
        object_type: 'CAR_EXTERIOR',
        style_key: style,
        aspect_ratio: ratio,
        output_count: Number(count),
      }),
    onSuccess: () => {
      toast.add({
        type: 'success',
        title: 'Image generation queued',
        description: 'The result will appear here when the secure background job completes.',
      });
      void client.invalidateQueries({ queryKey: ['ai-image-creation'] });
    },
    onError: () =>
      toast.add({
        type: 'error',
        title: 'Image was not queued',
        description: 'Verify the connected image provider and available AI credits, then retry.',
      }),
  });
  const image = useMutation({
    mutationFn: getAiImageUrl,
    onError: () =>
      toast.add({
        type: 'error',
        title: 'Preview is unavailable',
        description: 'The secure preview link could not be created. Try again shortly.',
      }),
  });
  if (workspace.isPending) return <AiImageCreationSkeleton />;
  if (workspace.isError || !workspace.data)
    return (
      <Alert>
        <AlertTitle>AI image creation is unavailable</AlertTitle>
        <AlertDescription>
          Confirm marketing access and deploy the AI image workflow.
        </AlertDescription>
      </Alert>
    );
  const connections = workspace.data.connections;
  return (
    <div className="mx-auto max-w-[1600px] space-y-5">
      <PageHeader spec={{ ...spec, primaryAction: undefined }} />
      <div className="grid gap-5 xl:grid-cols-[360px_minmax(0,1fr)_380px]">
        <PromptSettingsCard />
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Create image</CardTitle>
            <CardDescription>
              Use a connected tenant image provider. Results are stored privately in CRM storage.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                setConnectionId(selected);
                queue.mutate(new FormData(event.currentTarget));
              }}
            >
              <label className="grid gap-1.5 text-sm font-medium">
                Provider connection
                <Select value={selected} onValueChange={setConnectionId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Connect OpenRouter first" />
                  </SelectTrigger>
                  <SelectContent>
                    {connections.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.name} · {item.image_model}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <label className="grid gap-1.5 text-sm font-medium">
                Template
                <Select value={template} onValueChange={setTemplate}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="SOCIAL_POST">Social post</SelectItem>
                    <SelectItem value="BANNER">Banner</SelectItem>
                    <SelectItem value="STORY_REEL">Story / reel</SelectItem>
                    <SelectItem value="WHATSAPP_POST">WhatsApp post</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              <label className="grid gap-1.5 text-sm font-medium">
                Describe your image
                <Textarea
                  name="prompt"
                  required
                  minLength={4}
                  maxLength={3000}
                  placeholder="A premium SUV parked outside a modern showroom at night…"
                />
              </label>
              <div className="grid grid-cols-3 gap-2">
                <Select value={style} onValueChange={setStyle}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="REALISTIC">Realistic</SelectItem>
                    <SelectItem value="CINEMATIC">Cinematic</SelectItem>
                    <SelectItem value="PREMIUM">Premium</SelectItem>
                    <SelectItem value="MINIMAL">Minimal</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={ratio} onValueChange={setRatio}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1:1">1:1</SelectItem>
                    <SelectItem value="16:9">16:9</SelectItem>
                    <SelectItem value="9:16">9:16</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={count} onValueChange={setCount}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">1 image</SelectItem>
                    <SelectItem value="2">2 images</SelectItem>
                    <SelectItem value="4">4 images</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button className="w-full" disabled={queue.isPending || !selected}>
                <Sparkles className="size-4" />
                {queue.isPending
                  ? 'Queueing…'
                  : `Generate ${count} image${count === '1' ? '' : 's'}`}
              </Button>
            </form>
          </CardContent>
        </Card>
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Preview & results</CardTitle>
            <CardDescription>
              Completed images are private and available for five minutes per secure preview URL.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-3">
              {workspace.data.recent.flatMap((generation) =>
                generation.outputs.map((output) => (
                  <button
                    key={output.object_file_id}
                    type="button"
                    onClick={() => image.mutate(output.object_file_id)}
                    className="aspect-square rounded-lg border bg-muted text-xs text-muted-foreground hover:border-primary"
                  >
                    {image.isPending && image.variables === output.object_file_id ? (
                      <LoaderCircle className="mx-auto size-5 animate-spin" />
                    ) : (
                      <>
                        <ImagePlus className="mx-auto mb-2 size-5" />
                        Preview image {output.ordinal}
                        <span
                          role="button"
                          tabIndex={0}
                          className="mt-2 block text-[11px] font-medium text-primary underline"
                          onClick={(event) => {
                            event.stopPropagation();
                            setSavingAsset(output.object_file_id);
                          }}
                          onKeyDown={(event) => {
                            if (event.key !== 'Enter' && event.key !== ' ') return;
                            event.stopPropagation();
                            event.preventDefault();
                            setSavingAsset(output.object_file_id);
                          }}
                        >
                          Save to library
                        </span>
                      </>
                    )}
                  </button>
                )),
              )}
            </div>
            {image.data && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={image.data.download_url}
                alt="Generated CRM creative"
                className="mt-4 max-h-[420px] w-full rounded-lg border object-contain"
              />
            )}
          </CardContent>
        </Card>
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-base">Recent generations</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {workspace.data.recent.length ? (
              workspace.data.recent.map((item) => (
                <div key={item.id} className="rounded-lg border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium">{item.template_key.replaceAll('_', ' ')}</p>
                    <StatusBadge value={item.status} />
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{item.prompt}</p>
                  {item.safe_error_code && (
                    <p className="mt-1 text-xs text-destructive">{item.safe_error_code}</p>
                  )}
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">No generation requests yet.</p>
            )}
          </CardContent>
        </Card>
      </div>
      {savingAsset && (
        <SaveAssetDialog objectFileId={savingAsset} onClose={() => setSavingAsset(null)} />
      )}
    </div>
  );
}
