import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  FadeIn,
  LinearTransition,
  useAnimatedStyle,
  withSpring,
} from 'react-native-reanimated';
import { relativeWhen } from '@/components/lead-row';
import { Screen } from '@/components/screen';
import {
  Avatar,
  Badge,
  Card,
  ErrorState,
  PrimaryButton,
  SkeletonList,
} from '@/components/ui/basics';
import { Icon, type IconName } from '@/components/ui/icon';
import { PressableScale } from '@/components/ui/pressable-scale';
import { useToast } from '@/components/ui/toast';
import { useCallFlow, useWorkRefresh } from '@/features/call-flow/call-flow';
import {
  FollowupSheet,
  TemperatureSheet,
  TestDriveSheet,
  TransferSheet,
} from '@/features/lead-detail/sheets';
import { currentRole, openWhatsApp } from '@/lib/contact';
import { fetchMobileLeadDetail, type MobileLeadDetail, type MobileRole } from '@/lib/lead-detail';
import { snappy } from '@/motion/springs';
import { colors, enumLabel, font, radius, space, stageTone, temperatureTone } from '@/theme';

type SheetKind = 'followup' | 'temperature' | 'transfer' | 'test-drive' | null;
const intakeClosed = new Set(['Lost', 'Transferred to Sales']);

const stamp = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
});

function when(value: string | null) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : stamp.format(date);
}

// Some activity rows carry only their event code (FOLLOWUP_COMPLETED).
function timelineTitle(title: string) {
  if (!/^[A-Z][A-Z0-9_]+$/.test(title)) return title;
  const words = title.toLowerCase().replaceAll('_', ' ').replace('followup', 'follow-up');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// Only the requirements that have a value; an unanswered question stays hidden.
function requirementRows(requirements: MobileLeadDetail['lead']['requirements']) {
  if (!requirements) return [];
  const yesNo = (value: boolean | null) => (value === null ? null : value ? 'Yes' : 'No');
  const budget = Number(requirements.budget_max);
  const rows: Array<[string, string | null]> = [
    ['Variant', requirements.variant],
    ['Budget', budget > 0 ? `Up to ₹${budget.toLocaleString('en-IN')}` : null],
    ['Buying timeline', requirements.purchase_timeline],
    ['Needs finance', yesNo(requirements.finance_required)],
    ['Has exchange', yesNo(requirements.exchange_required)],
    ['Wants test drive', yesNo(requirements.test_drive_required)],
    ['Also considering', requirements.competitors?.join(', ') || null],
  ];
  return rows.filter((row): row is [string, string] => Boolean(row[1]));
}

function duration(seconds: number | null) {
  if (!seconds) return null;
  return `${Math.floor(seconds / 60)}m ${(seconds % 60).toString().padStart(2, '0')}s`;
}

export default function LeadDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [detail, setDetail] = useState<MobileLeadDetail>();
  const [role, setRole] = useState<MobileRole>(null);
  const [error, setError] = useState(false);
  const [sheet, setSheet] = useState<SheetKind>(null);
  const toast = useToast();
  const { call, changed } = useCallFlow();
  const load = useCallback(async () => {
    if (!id) return;
    setError(false);
    try {
      const [nextDetail, nextRole] = await Promise.all([fetchMobileLeadDetail(id), currentRole()]);
      setDetail(nextDetail);
      setRole(nextRole);
    } catch {
      setError(true);
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);
  useWorkRefresh(() => void load());
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };
  const done = (message: string) => {
    setSheet(null);
    toast({ message });
    void load();
    changed('edit');
  };
  const lead = detail?.lead;
  const next = detail?.followups.find(
    (item) => item.status === 'OPEN' || item.status === 'OVERDUE',
  );
  // After a handoff the open follow-up belongs to the new owner and is not in
  // the caller's list, but the lead still carries its time; the Leads card
  // shows it, so say whose it is rather than "No follow-up set".
  const ownerNextAt = !next ? (lead?.next_followup_at ?? null) : null;
  const nextAt = next?.due_at ?? ownerNextAt;
  const nextOverdue = nextAt ? new Date(nextAt).getTime() < Date.now() : false;
  const telecaller = role === 'telecaller';
  const canTransfer = Boolean(
    lead && detail?.access.can_update && !intakeClosed.has(lead.lifecycle_status),
  );
  const canTestDrive = Boolean(lead?.customer_id && detail?.access.can_appointments);
  return (
    <Screen
      back
      title={lead?.customer_name ?? 'Lead'}
      subtitle={lead ? lead.branch_name : undefined}
      refreshing={refreshing}
      onRefresh={() => void refresh()}
      footer={
        detail && lead ? (
          <>
            <PrimaryButton
              label="Follow-up"
              icon="alarm-outline"
              variant="secondary"
              disabled={!detail.access.can_followups}
              onPress={() => setSheet('followup')}
              style={styles.grow}
            />
            {telecaller ? (
              <PrimaryButton
                label="Qualify & transfer"
                icon="send"
                disabled={!canTransfer}
                onPress={() => setSheet('transfer')}
                style={styles.grow}
              />
            ) : (
              <PrimaryButton
                label="Test drive"
                icon="car-sport"
                disabled={!canTestDrive}
                onPress={() => setSheet('test-drive')}
                style={styles.grow}
              />
            )}
          </>
        ) : undefined
      }
    >
      {!detail && !error ? <SkeletonList rows={4} /> : null}
      {error ? <ErrorState title="This lead could not load" onRetry={() => void load()} /> : null}
      {detail && lead ? (
        <Animated.View entering={FadeIn.duration(220)} style={styles.stack}>
          <Card style={styles.hero}>
            <View style={styles.heroTop}>
              <Avatar
                name={lead.customer_name}
                tone={temperatureTone(lead.temperature)}
                size={58}
              />
              <View style={styles.grow}>
                <View style={styles.badges}>
                  <Badge label={lead.lifecycle_status} tone={stageTone(lead.lifecycle_status)} />
                  {lead.work_state ? (
                    <Badge
                      label={lead.work_state.replaceAll('_', ' ').toLowerCase()}
                      tone={stageTone(lead.work_state)}
                    />
                  ) : null}
                </View>
                <Text style={styles.model} numberOfLines={1}>
                  {lead.interested_model ?? 'Model not specified'}
                </Text>
                <Text style={styles.meta} numberOfLines={1}>
                  {lead.source} · {lead.phone}
                </Text>
              </View>
              <PressableScale
                onPress={() => setSheet('temperature')}
                disabled={!detail.access.can_update}
                style={[styles.temp, { backgroundColor: temperatureTone(lead.temperature).bg }]}
                accessibilityLabel="Change buying intent"
              >
                <Icon name="flame" size={16} color={temperatureTone(lead.temperature).fg} />
                <Text style={[styles.tempText, { color: temperatureTone(lead.temperature).fg }]}>
                  {lead.temperature ? enumLabel(lead.temperature) : 'Set'}
                </Text>
                <Icon name="chevron-down" size={14} color={temperatureTone(lead.temperature).fg} />
              </PressableScale>
            </View>
            <View style={styles.contact}>
              <PrimaryButton
                label="Call"
                icon="call"
                onPress={() =>
                  call({ leadId: lead.id, phone: lead.phone, name: lead.customer_name })
                }
                style={styles.grow}
              />
              <PrimaryButton
                label="WhatsApp"
                icon="logo-whatsapp"
                variant="success"
                onPress={() => void openWhatsApp(lead.phone)}
                style={styles.grow}
              />
            </View>
          </Card>

          <PressableScale
            scaleTo={0.98}
            disabled={!detail.access.can_followups}
            onPress={() => setSheet('followup')}
            style={[styles.nextStep, nextOverdue && styles.nextOverdue]}
          >
            <View style={styles.nextIcon}>
              <Icon name="alarm" size={20} color={colors.warning} />
            </View>
            <View style={styles.grow}>
              <Text style={styles.nextLabel}>Next step</Text>
              <Text style={styles.nextValue} numberOfLines={1}>
                {next
                  ? next.reason
                  : ownerNextAt
                    ? `${lead.assigned_user_name ?? 'Lead owner'}'s follow-up`
                    : 'No follow-up set'}
              </Text>
              {nextAt ? (
                <Text style={[styles.nextWhen, nextOverdue && styles.nextWhenOverdue]}>
                  {nextOverdue ? 'Overdue · ' : ''}
                  {relativeWhen(nextAt)}
                </Text>
              ) : null}
            </View>
            <Text style={styles.nextAction}>{next ? 'Change' : 'Set'}</Text>
          </PressableScale>

          {detail.latest_ai_summary ? (
            <Card style={styles.ai}>
              <View style={styles.aiHead}>
                <Icon name="sparkles" size={16} color="#7c3aed" />
                <Text style={styles.aiTitle}>Last call summary</Text>
              </View>
              <Text style={styles.aiText} numberOfLines={5}>
                {detail.latest_ai_summary}
              </Text>
            </Card>
          ) : null}

          <Section title="Requirement" icon="car-outline" defaultOpen>
            <Row label="Interested in" value={lead.interested_model ?? 'Not specified'} />
            {requirementRows(lead.requirements).map(([label, value]) => (
              <Row key={label} label={label} value={value} />
            ))}
            <Row label="Assigned to" value={lead.assigned_user_name ?? 'Unassigned'} />
            <Row
              label="Branch"
              value={[lead.branch_name, lead.team_name].filter(Boolean).join(' · ')}
            />
            {lead.email ? <Row label="Email" value={lead.email} /> : null}
            {lead.customer_id ? (
              <PressableScale
                scaleTo={0.98}
                onPress={() =>
                  router.push({
                    pathname: '/customer/[id]',
                    params: { id: lead.customer_id as string },
                  })
                }
                style={styles.linkRow}
              >
                <Text style={styles.link}>Open customer profile</Text>
                <Icon name="chevron-forward" size={16} color={colors.primary} />
              </PressableScale>
            ) : null}
          </Section>

          {detail.calls.length ? (
            <Section
              title={`Calls (${detail.counts.calls || detail.calls.length})`}
              icon="call-outline"
            >
              {detail.calls.slice(0, 5).map((item) => (
                <PressableScale
                  key={item.id}
                  scaleTo={0.98}
                  onPress={() => router.push({ pathname: '/call/[id]', params: { id: item.id } })}
                  style={styles.event}
                >
                  <View style={[styles.eventDot, { backgroundColor: colors.success }]} />
                  <View style={styles.grow}>
                    <Text style={styles.eventTitle}>
                      {(item.outcome ?? item.status).replaceAll('_', ' ').toLowerCase()}
                    </Text>
                    <Text style={styles.eventDetail}>
                      {[duration(item.duration_seconds), when(item.started_at)]
                        .filter(Boolean)
                        .join(' · ')}
                    </Text>
                  </View>
                  <Icon name="chevron-forward" size={16} color={colors.faint} />
                </PressableScale>
              ))}
            </Section>
          ) : null}

          <Section title="Timeline" icon="time-outline">
            <Timeline items={detail.timeline} />
          </Section>
        </Animated.View>
      ) : null}

      {detail && sheet === 'followup' ? (
        <FollowupSheet
          detail={detail}
          initial={next ? { reason: next.reason, dueAt: next.due_at } : undefined}
          onClose={() => setSheet(null)}
          onSaved={done}
        />
      ) : null}
      {detail && sheet === 'temperature' ? (
        <TemperatureSheet detail={detail} onClose={() => setSheet(null)} onSaved={done} />
      ) : null}
      {detail && sheet === 'transfer' ? (
        <TransferSheet
          detail={detail}
          onClose={() => setSheet(null)}
          onReload={load}
          onTransferred={(name) => done(`Transferred to ${name}.`)}
        />
      ) : null}
      {detail && sheet === 'test-drive' ? (
        <TestDriveSheet
          detail={detail}
          onClose={() => setSheet(null)}
          onScheduled={() => done('Test drive scheduled.')}
        />
      ) : null}
    </Screen>
  );
}

function Section({
  title,
  icon,
  defaultOpen = false,
  children,
}: {
  title: string;
  icon: IconName;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const chevron = useAnimatedStyle(() => ({
    transform: [{ rotate: withSpring(open ? '180deg' : '0deg', snappy) }],
  }));
  return (
    <Animated.View layout={LinearTransition.duration(200)} style={styles.section}>
      <PressableScale
        scaleTo={0.99}
        onPress={() => setOpen((value) => !value)}
        style={styles.sectionHead}
      >
        <Icon name={icon} size={18} color={colors.muted} />
        <Text style={styles.sectionTitle}>{title}</Text>
        <Animated.View style={chevron}>
          <Icon name="chevron-down" size={18} color={colors.muted} />
        </Animated.View>
      </PressableScale>
      {open ? (
        <Animated.View entering={FadeIn.duration(180)} style={styles.sectionBody}>
          {children}
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

function Timeline({ items }: { items: MobileLeadDetail['timeline'] }) {
  const [all, setAll] = useState(false);
  if (!items.length) return <Text style={styles.eventDetail}>No activity yet.</Text>;
  const shown = all ? items : items.slice(0, 5);
  return (
    <>
      {shown.map((item) => (
        <View key={item.id} style={styles.event}>
          <View style={styles.eventDot} />
          <View style={styles.grow}>
            <Text style={styles.eventTitle}>{timelineTitle(item.title)}</Text>
            {item.detail ? (
              <Text style={styles.eventDetail} numberOfLines={2}>
                {item.detail}
              </Text>
            ) : null}
          </View>
          <Text style={styles.eventTime}>{when(item.occurred_at)}</Text>
        </View>
      ))}
      {items.length > 5 && !all ? (
        <PressableScale onPress={() => setAll(true)} style={styles.linkRow}>
          <Text style={styles.link}>Show all {items.length}</Text>
          <Icon name="chevron-down" size={16} color={colors.primary} />
        </PressableScale>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1 },
  stack: { gap: space.md },
  hero: { padding: space.lg, gap: space.lg },
  heroTop: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  model: { color: colors.text, fontSize: font.heading, fontWeight: '600', marginTop: 6 },
  meta: { color: colors.muted, fontSize: font.small, fontWeight: '600', marginTop: 2 },
  temp: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 7,
    alignSelf: 'flex-start',
  },
  tempText: { fontSize: font.label, fontWeight: '600' },
  contact: { flexDirection: 'row', gap: space.sm },
  nextStep: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.md,
    borderRadius: radius.lg,
    backgroundColor: colors.warningSoft,
    borderWidth: 1,
    borderColor: colors.warningBorder,
  },
  nextOverdue: { backgroundColor: colors.dangerSoft, borderColor: colors.dangerBorder },
  nextIcon: {
    width: 38,
    height: 38,
    borderRadius: 12,
    backgroundColor: colors.onColor,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nextLabel: {
    color: colors.muted,
    fontSize: font.caption,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  nextValue: { color: colors.text, fontSize: font.body, fontWeight: '600', marginTop: 2 },
  nextWhen: { color: colors.muted, fontSize: font.small, fontWeight: '700', marginTop: 2 },
  nextWhenOverdue: { color: colors.danger },
  nextAction: { color: colors.primary, fontSize: font.row, fontWeight: '600' },
  ai: { padding: space.lg, gap: space.sm, backgroundColor: '#faf5ff', borderColor: '#e9d5ff' },
  aiHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  aiTitle: { color: colors.violetStrong, fontSize: font.small, fontWeight: '600' },
  aiText: { color: colors.text, fontSize: font.row, lineHeight: 21 },
  section: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.lg },
  sectionTitle: { flex: 1, color: colors.text, fontSize: font.body, fontWeight: '600' },
  sectionBody: { paddingHorizontal: space.lg, paddingBottom: space.lg, gap: space.md },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: space.md },
  rowLabel: { color: colors.muted, fontSize: font.small, fontWeight: '600' },
  rowValue: {
    flex: 1,
    color: colors.text,
    fontSize: font.row,
    fontWeight: '700',
    textAlign: 'right',
  },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start' },
  link: { color: colors.primary, fontSize: font.row, fontWeight: '600' },
  event: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  eventDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.primary, marginTop: 5 },
  eventTitle: {
    color: colors.text,
    fontSize: font.row,
    fontWeight: '700',
    textTransform: 'capitalize',
  },
  eventDetail: { color: colors.muted, fontSize: font.label, fontWeight: '500', marginTop: 2 },
  eventTime: { color: colors.faint, fontSize: font.caption, fontWeight: '700' },
});
