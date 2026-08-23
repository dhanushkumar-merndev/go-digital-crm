'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ImagePlus, LoaderCircle, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/components/shared/page-header';
import { PageSkeleton } from '@/components/shared/page-skeleton';
import { StatusBadge } from '@/components/shared/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { fetchAiImageWorkspace, getAiImageUrl, queueAiImage } from './ai-image-creation-api';

export function AiImageCreationWorkspace({ spec }: { spec: PageSpec }) {
  const client = useQueryClient();
  const workspace = useQuery({
    queryKey: ['ai-image-creation'],
    queryFn: fetchAiImageWorkspace,
    refetchInterval: 8_000,
    staleTime: 5_000,
  });
  const [connectionId, setConnectionId] = useState('');
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
  if (workspace.isPending) return <PageSkeleton />;
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
                    <SelectValue placeholder="Connect OpenAI first" />
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
                      </>
                    )}
                  </button>
                )),
              )}
            </div>
            {image.data && (
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
    </div>
  );
}
