import { router, type Href } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { LeadTile, relativeWhen, type LeadRowData } from '@/components/lead-row';
import { RecordingSyncButton } from '@/components/recording-sync-button';
import { SwipeRow } from '@/components/swipe-row';
import { Avatar, Card, EmptyState, SectionHeader } from '@/components/ui/basics';
import { Icon, type IconName } from '@/components/ui/icon';
import { PressableScale } from '@/components/ui/pressable-scale';
import { RowIcon, RowPressable } from '@/components/ui/row';
import { Sheet } from '@/components/ui/sheet';
import { useCallFlow, useWorkRefresh } from '@/features/call-flow/call-flow';
import { resetRoleCache } from '@/lib/contact';
import type { TodayTarget } from '@/lib/today-targets';
import { supabase } from '@/lib/supabase';
import { colors, font, priorityTone, radius, shadow, space } from '@/theme';

export function useProfile() {
  const [profile, setProfile] = useState<{ name: string; email: string }>();
  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      const user = data.session?.user;
      if (!user) return;
      const meta = user.user_metadata as Record<string, unknown> | undefined;
      const full = typeof meta?.full_name === 'string' ? meta.full_name : '';
      const email = user.email ?? '';
      setProfile({ name: full || email.split('@')[0] || 'there', email });
    });
  }, []);
  return profile;
}

export function greeting(now = new Date()) {
  const hour = now.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

const todayLabel = new Intl.DateTimeFormat('en-IN', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});

export function TodayHeader({ role }: { role: 'telecaller' | 'sales' }) {
  const profile = useProfile();
  const [more, setMore] = useState(false);
  const first = profile?.name.split(' ')[0] ?? '';
  return (
    <View style={styles.header}>
      <View style={styles.grow}>
        <Text style={styles.date}>{todayLabel.format(new Date())}</Text>
        <Text style={styles.hello} numberOfLines={1}>
          {greeting()}
          {first ? `, ${first.charAt(0).toUpperCase()}${first.slice(1)}` : ''}
        </Text>
      </View>
      <RecordingSyncButton />
      <PressableScale onPress={() => setMore(true)} accessibilityLabel="More" scaleTo={0.9}>
        <Avatar
          name={profile?.name ?? '?'}
          tone={{ fg: colors.onColor, bg: colors.primary }}
          size={42}
        />
      </PressableScale>
      {more ? (
        <MoreSheet role={role} email={profile?.email} onClose={() => setMore(false)} />
      ) : null}
    </View>
  );
}

function MoreSheet({
  role,
  email,
  onClose,
}: {
  role: 'telecaller' | 'sales';
  email?: string;
  onClose: () => void;
}) {
  const base = role === 'telecaller' ? '/telecaller' : '/sales';
  const items: Array<{ icon: IconName; label: string; href: Href }> = [
    { icon: 'call-outline', label: 'Call history', href: `${base}/calls` as Href },
    { icon: 'mic-outline', label: 'Call recordings', href: '/recordings' },
    ...(role === 'sales'
      ? [
          {
            icon: 'car-sport-outline' as IconName,
            label: 'Stock check',
            href: '/sales/stock-check' as Href,
          },
        ]
      : []),
    { icon: 'settings-outline', label: 'Settings', href: '/settings' },
  ];
  const go = (href: Href) => {
    onClose();
    router.push(href);
  };
  return (
    <Sheet title="More" subtitle={email} onClose={onClose}>
      <Card>
        {items.map((item, index) => (
          <PressableScale
            key={item.label}
            scaleTo={0.98}
            onPress={() => go(item.href)}
            style={[styles.moreRow, index > 0 && styles.divider]}
          >
            <View style={styles.moreIcon}>
              <Icon name={item.icon} size={20} color={colors.primary} />
            </View>
            <Text style={styles.moreText}>{item.label}</Text>
            <Icon name="chevron-forward" size={18} color={colors.faint} />
          </PressableScale>
        ))}
      </Card>
      <PressableScale
        scaleTo={0.98}
        onPress={async () => {
          onClose();
          resetRoleCache();
          await supabase.auth.signOut({ scope: 'local' });
          router.replace('/');
        }}
        style={styles.signOut}
      >
        <Icon name="log-out-outline" size={20} color={colors.danger} />
        <Text style={styles.signOutText}>Sign out</Text>
      </PressableScale>
    </Sheet>
  );
}

export function KpiTiles({
  items,
}: {
  items: Array<{ label: string; value: number; icon: IconName; tone: string; href?: Href }>;
}) {
  return (
    <View style={styles.tiles}>
      {items.map((item) => (
        <Pressable
          key={item.label}
          disabled={!item.href}
          onPress={() => item.href && router.push(item.href)}
          android_ripple={{ color: colors.pressed }}
          style={styles.tile}
        >
          <View style={styles.tileTop}>
            <Icon name={item.icon} size={14} color={item.tone} />
            <Text style={styles.tileLabel} numberOfLines={1}>
              {item.label}
            </Text>
          </View>
          <Text style={styles.tileValue}>{item.value.toLocaleString('en-IN')}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const targetTones = [colors.primary, colors.success, colors.warning, colors.violet];

/** Progress against today's targets; renders nothing when none are set. */
export function TargetsCard({ items }: { items: TodayTarget[] | undefined }) {
  if (!items?.length) return null;
  return (
    <Card style={styles.targets}>
      <Text style={styles.targetsTitle}>Today&apos;s targets</Text>
      <View style={styles.targetRow}>
        {items.map((item, index) => {
          const tone = targetTones[index % targetTones.length]!;
          const share = Math.min(1, item.done / item.target);
          return (
            <View key={item.key} style={styles.targetCell}>
              <Text style={styles.targetValue}>
                {item.done}
                <Text style={styles.targetOf}> / {item.target}</Text>
              </Text>
              <Text style={styles.targetLabel} numberOfLines={1}>
                {item.label}
              </Text>
              <View style={styles.track}>
                <View style={[styles.fill, { width: `${share * 100}%`, backgroundColor: tone }]} />
              </View>
            </View>
          );
        })}
      </View>
    </Card>
  );
}

/** One-tap shortcuts to screens that exist for this role; no dead buttons. */
export function QuickActions({
  items,
}: {
  items: Array<{ label: string; icon: IconName; tone: string; href: Href }>;
}) {
  return (
    <Card style={styles.quick}>
      {items.map((item) => (
        <PressableScale
          key={item.label}
          scaleTo={0.94}
          accessibilityRole="button"
          accessibilityLabel={item.label}
          onPress={() => router.push(item.href)}
          style={styles.quickItem}
        >
          <View style={[styles.quickIcon, { backgroundColor: item.tone }]}>
            <Icon name={item.icon} size={22} color={colors.onColor} />
          </View>
          <Text style={styles.quickLabel} numberOfLines={1}>
            {item.label}
          </Text>
        </PressableScale>
      ))}
    </Card>
  );
}

/** The latest leads as a sideways strip, so Home stays one screen tall. */
export function RecentLeadsStrip({ leads, href }: { leads: LeadRowData[]; href: Href }) {
  if (!leads.length) return null;
  return (
    <View style={styles.section}>
      <SectionHeader title="Recent leads" action="View all" onAction={() => router.push(href)} />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.strip}
      >
        {leads.map((lead) => (
          <LeadTile key={lead.id} lead={lead} />
        ))}
      </ScrollView>
    </View>
  );
}

type CallNextRow = {
  id: string;
  version: number;
  lead_id: string | null;
  phone: string | null;
  customer_name: string | null;
  reason: string | null;
  interested_model: string | null;
  due_at: string | null;
  priority: string;
};

// The five oldest overdue follow-ups, each one tap from the dialer.
export function CallNext({ followupsHref }: { followupsHref: Href }) {
  const { call } = useCallFlow();
  const [rows, setRows] = useState<CallNextRow[]>();
  const [total, setTotal] = useState(0);
  const load = useCallback(async () => {
    const { data } = await supabase.rpc('get_followup_workspace_filtered_page', {
      target_status: 'overdue',
      target_page: 1,
      // The RPC accepts only 25 / 50 / 100; the first page is cheap and we show five.
      target_page_size: 25,
      target_sort: 'scheduled:asc',
      target_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata',
    });
    const result = (data ?? {}) as { records?: CallNextRow[] | null; total?: number | null };
    setRows((result.records ?? []).slice(0, 5));
    setTotal(Number(result.total ?? 0));
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useWorkRefresh(() => void load());
  return (
    <View style={styles.section}>
      <SectionHeader
        title="Call next"
        action={total ? `${total.toLocaleString('en-IN')} overdue` : undefined}
        onAction={() => router.push(followupsHref)}
      />
      {rows && !rows.length ? (
        <Card>
          <EmptyState title="All caught up" detail="No overdue follow-ups right now." />
        </Card>
      ) : null}
      {rows?.length ? (
        <Card>
          {rows.map((row, index) => {
            const name = row.customer_name || 'Customer';
            const phone = row.phone;
            const startCall = phone
              ? () =>
                  call({
                    leadId: row.lead_id,
                    phone,
                    name,
                    followup: { id: row.id, version: Number(row.version) },
                  })
              : undefined;
            return (
              // Swipe right to call, the same gesture as the lead lists.
              <View key={row.id} style={index > 0 ? styles.divider : undefined}>
                <SwipeRow
                  left={
                    startCall
                      ? { label: 'Call', icon: 'call', color: colors.success, onTrigger: startCall }
                      : undefined
                  }
                >
                  <RowPressable
                    disabled={!row.lead_id}
                    onPress={() =>
                      row.lead_id &&
                      router.push({ pathname: '/lead/[id]', params: { id: row.lead_id } })
                    }
                  >
                    <Avatar name={name} tone={priorityTone(row.priority)} size={36} />
                    <View style={styles.main}>
                      <Text style={styles.callName} numberOfLines={1}>
                        {name}
                      </Text>
                      <Text style={styles.callMeta} numberOfLines={1}>
                        {row.reason || 'Follow-up'}
                        <Text style={styles.overdue}> · {relativeWhen(row.due_at)}</Text>
                      </Text>
                    </View>
                    {startCall ? (
                      <RowIcon
                        icon="call"
                        label={`Call ${name}`}
                        color={colors.primary}
                        filled
                        onPress={startCall}
                      />
                    ) : null}
                  </RowPressable>
                </SwipeRow>
              </View>
            );
          })}
        </Card>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  date: { color: colors.muted, fontSize: font.small, fontWeight: '500' },
  hello: {
    color: colors.text,
    fontSize: font.display,
    fontWeight: '700',
    letterSpacing: -0.4,
    marginTop: 2,
  },
  tiles: { flexDirection: 'row', gap: space.sm },
  tile: {
    flex: 1,
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    gap: 4,
    overflow: 'hidden',
    ...shadow,
  },
  tileTop: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  tileValue: { color: colors.text, fontSize: font.display, fontWeight: '700', letterSpacing: -0.4 },
  tileLabel: { flexShrink: 1, color: colors.muted, fontSize: font.label, fontWeight: '500' },
  section: { gap: space.sm },
  targets: { padding: space.lg, gap: space.md },
  targetsTitle: { color: colors.text, fontSize: font.heading, fontWeight: '700' },
  targetRow: { flexDirection: 'row', gap: space.md },
  targetCell: { flex: 1, alignItems: 'center', gap: 4 },
  targetValue: { color: colors.text, fontSize: font.title, fontWeight: '700' },
  targetOf: { color: colors.muted, fontSize: font.small, fontWeight: '600' },
  targetLabel: { color: colors.muted, fontSize: font.label },
  track: {
    alignSelf: 'stretch',
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.subtle,
    overflow: 'hidden',
  },
  fill: { height: 5, borderRadius: 3 },
  quick: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: space.md,
    paddingHorizontal: space.sm,
  },
  quickItem: { flex: 1, alignItems: 'center', gap: 6 },
  quickIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  quickLabel: { color: colors.text, fontSize: font.label, fontWeight: '500' },
  strip: { gap: space.md, paddingRight: space.lg },
  main: { flex: 1, minWidth: 0, gap: 2 },
  callName: { color: colors.text, fontSize: font.body, fontWeight: '600' },
  callMeta: { color: colors.muted, fontSize: font.small },
  overdue: { color: colors.danger },
  moreRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  moreIcon: {
    width: 36,
    height: 36,
    borderRadius: 12,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  moreText: { flex: 1, color: colors.text, fontSize: font.body, fontWeight: '500' },
  signOut: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    height: 50,
    borderRadius: radius.md,
    backgroundColor: colors.dangerSoft,
  },
  signOutText: { color: colors.danger, fontSize: font.body, fontWeight: '600' },
});
