'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, Image as ImageIcon, Search, Tag } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/components/shared/page-header';
import { StatusBadge } from '@/components/shared/status-badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import type { PageSpec } from '@/lib/domain';
import {
  archiveMarketingAsset,
  fetchMarketingAssetLibrary,
  getAiImageUrl,
  marketingAssetLibraryKey,
} from './ai-image-creation-api';

function formatSize(bytes: number) {
  return bytes > 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function AssetLibraryWorkspace({ spec }: { spec: PageSpec }) {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [tag, setTag] = useState('');
  const client = useQueryClient();
  const library = useQuery({
    queryKey: marketingAssetLibraryKey(page, search, tag),
    queryFn: () => fetchMarketingAssetLibrary({ page, pageSize: 25, search, tag }),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  // Stored objects are private; a preview URL is minted per request and expires.
  const preview = useMutation({
    mutationFn: getAiImageUrl,
    onError: () =>
      toast.add({
        type: 'error',
        title: 'Preview is unavailable',
        description: 'The secure preview link could not be created. Try again shortly.',
      }),
  });
  const archive = useMutation({
    mutationFn: archiveMarketingAsset,
    onSuccess: () => {
      toast.add({
        type: 'success',
        title: 'Asset archived',
        description: 'The image itself is kept, so campaigns that already used it still render.',
      });
      void client.invalidateQueries({ queryKey: ['marketing-asset-library'] });
    },
    onError: () =>
      toast.add({
        type: 'error',
        title: 'Asset was not archived',
        description: 'Confirm marketing access, then try again.',
      }),
  });

  if (library.isError)
    return (
      <div className="space-y-5">
        <PageHeader spec={{ ...spec, primaryAction: undefined }} />
        <Alert>
          <AlertTitle>The asset library is unavailable</AlertTitle>
          <AlertDescription>
            Confirm marketing access and deploy the asset library migration.
          </AlertDescription>
        </Alert>
      </div>
    );
  const records = library.data?.records ?? [];
  const total = library.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / 25));
  return (
    <div className="mx-auto max-w-[1600px] space-y-5">
      <PageHeader spec={{ ...spec, primaryAction: undefined }} />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Card className="shadow-none">
          <CardHeader className="border-b p-4">
            <div className="flex flex-wrap gap-3">
              <div className="relative min-w-0 flex-1">
                <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="pl-9"
                  value={search}
                  onChange={(event) => {
                    setPage(1);
                    setSearch(event.target.value);
                  }}
                  placeholder="Search asset name"
                />
              </div>
              <div className="relative w-56">
                <Tag className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="pl-9"
                  value={tag}
                  onChange={(event) => {
                    setPage(1);
                    setTag(event.target.value);
                  }}
                  placeholder="Filter by tag"
                />
              </div>
            </div>
          </CardHeader>
          <CardContent className="overflow-x-auto p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Asset</TableHead>
                  <TableHead>Tags</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {records.length ? (
                  records.map((asset) => (
                    <TableRow key={asset.id}>
                      <TableCell>
                        <p className="font-medium">{asset.name}</p>
                        <p className="text-xs text-muted-foreground">{asset.created_by_name}</p>
                      </TableCell>
                      <TableCell className="max-w-56 truncate text-xs text-muted-foreground">
                        {asset.tags.length ? asset.tags.join(', ') : '—'}
                      </TableCell>
                      <TableCell>
                        <StatusBadge value={asset.source} />
                      </TableCell>
                      <TableCell>{formatSize(asset.size_bytes)}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => preview.mutate(asset.object_file_id)}
                          >
                            <ImageIcon /> Preview
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={archive.isPending}
                            onClick={() => archive.mutate(asset.id)}
                          >
                            <Archive /> Archive
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={5} className="h-28 text-center text-muted-foreground">
                      No assets match this view. Generate an image and save it to the library.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
          <div className="flex items-center justify-between border-t p-3 text-sm text-muted-foreground">
            <span>{total} assets</span>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={page <= 1}
                onClick={() => setPage((current) => current - 1)}
              >
                Previous
              </Button>
              <span>
                Page {page} / {pages}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={page >= pages}
                onClick={() => setPage((current) => current + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </Card>
        <Card className="shadow-none">
          <CardHeader className="border-b p-4 text-sm font-medium">Preview</CardHeader>
          <CardContent className="p-4">
            {preview.data ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={preview.data.download_url}
                alt="Marketing asset"
                className="max-h-[420px] w-full rounded-lg border object-contain"
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                Choose an asset to preview it. Links are private and short-lived.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
