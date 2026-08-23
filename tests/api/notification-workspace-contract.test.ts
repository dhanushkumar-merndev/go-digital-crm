import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

const migration = source('supabase/migrations/202608150001_foundation_security_hardening.sql');
const api = source('src/features/notifications/notification-workspace-api.ts');
const workspace = source('src/features/notifications/notification-workspace.tsx');
const route = source('src/app/[role]/[[...slug]]/page.tsx');

describe('notification workspace contract', () => {
  it('uses the existing authenticated-user RLS policy and safe mark-read RPC', () => {
    expect(migration).toContain('create policy notifications_read on public.notifications');
    expect(migration).toContain('user_id = auth.uid()');
    expect(migration).toContain('create or replace function public.mark_notification_read');
    expect(migration).toContain('and user_id = auth.uid()');
    expect(migration).toContain(
      'grant execute on function public.mark_notification_read(uuid) to authenticated',
    );
  });

  it('keeps filters and page boundaries server-side with approved page sizes', () => {
    expect(api).toContain('const pageSizes = [25, 50, 100] as const');
    expect(api).toContain(".from('notifications')");
    expect(api).toContain("request = request.is('read_at', null)");
    expect(api).toContain("request = request.not('read_at', 'is', null)");
    expect(api).toContain('request = request.or(`title.ilike.%${search}%,body.ilike.%${search}%`)');
    expect(api).toContain('.range(from, from + input.pageSize)');
  });

  it('uses scoped query keys, debounced search, and only invalidates notification queries', () => {
    expect(workspace).toContain('useDebouncedValue(searchInput, 300)');
    expect(workspace).toContain("workspaceSession?.organizationId ?? 'no-organization'");
    expect(workspace).toContain("workspaceSession?.userId ?? 'no-user'");
    expect(workspace).toContain('markHeaderNotificationRead');
    expect(workspace).toContain('invalidateQueries({ queryKey: notificationWorkspaceKey })');
    expect(workspace).toContain('invalidateQueries({ queryKey: headerNotificationsKey })');
  });

  it('routes System Administrator alerts to the real workspace before the unavailable fallback', () => {
    expect(route).toMatch(
      /role === 'system-administrator'\s*&&\s*slug\[0\] === 'alerts-notifications'/,
    );
    expect(route.indexOf('return <NotificationWorkspace')).toBeLessThan(
      route.indexOf('<ProductionDataUnavailable'),
    );
  });
});
