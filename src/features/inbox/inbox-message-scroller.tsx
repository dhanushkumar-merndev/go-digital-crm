'use client';

import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';

/** Load a bounded, server-cursor page only when the reader reaches the top. */
export function InboxMessageScroller({
  identity,
  count,
  newestId,
  hasMore,
  fetching,
  loadMore,
  children,
}: {
  identity: string;
  count: number;
  newestId?: string;
  hasMore: boolean;
  fetching: boolean;
  loadMore: () => Promise<unknown>;
  children: ReactNode;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const previous = useRef<{ identity: string; count: number } | null>(null);
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const pinned = useRef(true);
  const loading = useRef(false);
  useLayoutEffect(() => {
    const node = viewport.current;
    if (!node) return;
    if (previous.current?.identity !== identity || !previous.current.count) {
      node.scrollTop = node.scrollHeight;
      anchor.current = null;
      pinned.current = true;
    } else if (anchor.current && count !== previous.current.count) {
      node.scrollTop = anchor.current.top + node.scrollHeight - anchor.current.height;
      anchor.current = null;
    } else if (pinned.current) node.scrollTop = node.scrollHeight;
    previous.current = { identity, count };
  }, [identity, count, newestId]);
  async function earlier() {
    const node = viewport.current;
    if (!node || !hasMore || fetching || loading.current) return;
    loading.current = true;
    anchor.current = { height: node.scrollHeight, top: node.scrollTop };
    try {
      await loadMore();
    } finally {
      loading.current = false;
    }
  }
  return (
    <div
      ref={viewport}
      className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 [overflow-anchor:none]"
      onScroll={(event) => {
        const node = event.currentTarget;
        pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
        if (node.scrollTop < 60) void earlier();
      }}
    >
      {hasMore && (
        <Button variant="outline" size="sm" disabled={fetching} onClick={() => void earlier()}>
          {fetching ? 'Loading earlier messages…' : 'Load earlier messages'}
        </Button>
      )}
      {children}
    </div>
  );
}
