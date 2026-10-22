import { router } from 'expo-router';
import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SwipeRow } from '@/components/swipe-row';
import { Avatar, Badge } from '@/components/ui/basics';
import { Icon, type IconName } from '@/components/ui/icon';
import { RowIcon, RowIcons, RowPressable } from '@/components/ui/row';
import { useCallFlow } from '@/features/call-flow/call-flow';
import { openWhatsApp } from '@/lib/contact';
import { colors, font, radius, space, stageTone, temperatureTone } from '@/theme';

export type LeadRowData = {
  id: string;
  name: string;
  phone: string;
  model: string | null;
  source: string;
  stage: string | null;
  temperature: string | null;
  nextFollowupAt: string | null;
  /** Shown as "10m ago" on the card; omitted where the row has no such field. */
  updatedAt?: string | null;
  /** Budget range from the lead's requirements, when the list returns it. */
  budget?: string | null;
  /** The customer's city, when the list returns it. */
  location?: string | null;
};

const temperatureLabels: Record<string, string> = {
  HOT: 'Hot',
  WARM: 'Warm',
  COLD: 'Cold',
  DORMANT: 'Dormant',
};

/** "Just now", "10m ago", "3h ago", "2d ago", then a date. */
export function timeAgo(value: string | null | undefined) {
  if (!value) return null;
  const at = new Date(value).getTime();
  if (Number.isNaN(at)) return null;
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)}h ago`;
  if (minutes < 7 * 24 * 60) return `${Math.round(minutes / (24 * 60))}d ago`;
  return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short' }).format(at);
}

/** 9876543210 -> "98765 43210", the way the number is read aloud. */
function displayPhone(phone: string) {
  const digits = phone.replace(/\D/g, '');
  const local = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
  return local.length === 10 ? `${local.slice(0, 5)} ${local.slice(5)}` : phone;
}

const followupFormat = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
});

export function relativeWhen(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);
  const time = new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit' }).format(
    date,
  );
  if (date.toDateString() === today.toDateString()) return `Today ${time}`;
  if (date.toDateString() === tomorrow.toDateString()) return `Tomorrow ${time}`;
  return followupFormat.format(date);
}

export const LeadRow = memo(function LeadRow({ lead }: { lead: LeadRowData }) {
  const { call } = useCallFlow();
  const startCall = () => call({ leadId: lead.id, phone: lead.phone, name: lead.name });
  const next = relativeWhen(lead.nextFollowupAt);
  const overdue = lead.nextFollowupAt
    ? new Date(lead.nextFollowupAt).getTime() < Date.now()
    : false;
  return (
    <SwipeRow left={{ label: 'Call', icon: 'call', color: colors.success, onTrigger: startCall }}>
      <RowPressable
        onPress={() => router.push({ pathname: '/lead/[id]', params: { id: lead.id } })}
      >
        <Avatar name={lead.name} tone={temperatureTone(lead.temperature)} size={38} />
        <View style={styles.main}>
          <Text numberOfLines={1} style={styles.name}>
            {lead.name}
          </Text>
          <View style={styles.line}>
            {lead.stage ? <Badge label={lead.stage} tone={stageTone(lead.stage)} /> : null}
            <Text numberOfLines={1} style={styles.meta}>
              {[lead.model, lead.source].filter(Boolean).join(' · ')}
            </Text>
          </View>
          {next ? (
            <Text numberOfLines={1} style={[styles.when, overdue && styles.overdue]}>
              {overdue ? `Overdue · ${next}` : next}
            </Text>
          ) : null}
        </View>
        <RowIcons>
          <RowIcon
            icon="logo-whatsapp"
            label={`WhatsApp ${lead.name}`}
            color={colors.whatsapp}
            onPress={() => void openWhatsApp(lead.phone)}
          />
          <RowIcon
            icon="call"
            label={`Call ${lead.name}`}
            color={colors.primary}
            filled
            onPress={startCall}
          />
        </RowIcons>
      </RowPressable>
    </SwipeRow>
  );
});

function FactCell({
  icon,
  label,
  value,
  tone,
}: {
  icon: IconName;
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <View style={styles.fact}>
      <Icon name={icon} size={16} color={colors.primary} />
      <View style={styles.factText}>
        <Text style={styles.factLabel}>{label}</Text>
        <Text numberOfLines={1} style={[styles.factValue, tone ? { color: tone } : null]}>
          {value}
        </Text>
      </View>
    </View>
  );
}

/**
 * The My Leads card: who, how warm, what they asked about, and the two contact
 * actions, with the next step underneath. Budget and location appear only when
 * the list carries them; nothing is shown in their place.
 */
export const LeadCard = memo(function LeadCard({ lead }: { lead: LeadRowData }) {
  const { call } = useCallFlow();
  const startCall = () => call({ leadId: lead.id, phone: lead.phone, name: lead.name });
  const next = relativeWhen(lead.nextFollowupAt);
  const overdue = lead.nextFollowupAt
    ? new Date(lead.nextFollowupAt).getTime() < Date.now()
    : false;
  const tone = temperatureTone(lead.temperature);
  const temperature = lead.temperature ? temperatureLabels[lead.temperature] : null;
  const updated = timeAgo(lead.updatedAt);
  const extra = lead.budget
    ? { icon: 'cash-outline' as const, label: 'Budget', value: lead.budget }
    : lead.location
      ? { icon: 'location-outline' as const, label: 'Location', value: lead.location }
      : null;
  return (
    <SwipeRow
      radius={CARD_RADIUS}
      left={{ label: 'Call', icon: 'call', color: colors.success, onTrigger: startCall }}
    >
      <Pressable
        accessibilityRole="button"
        android_ripple={{ color: colors.pressed }}
        onPress={() => router.push({ pathname: '/lead/[id]', params: { id: lead.id } })}
        style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      >
        <View style={styles.cardTop}>
          <Avatar name={lead.name} tone={tone} size={46} />
          <View style={styles.main}>
            <View style={styles.nameLine}>
              <Text numberOfLines={1} style={styles.cardName}>
                {lead.name}
              </Text>
              {temperature ? <Badge label={temperature} tone={tone} /> : null}
            </View>
            <Text numberOfLines={1} style={styles.meta}>
              {[lead.model, lead.source].filter(Boolean).join('  •  ')}
            </Text>
            <View style={styles.phoneLine}>
              <Icon name="call-outline" size={13} color={colors.success} />
              <Text style={styles.phone}>{displayPhone(lead.phone)}</Text>
            </View>
          </View>
          <View style={styles.side}>
            {updated ? (
              <View style={styles.updated}>
                <Text style={styles.updatedText}>{updated}</Text>
                <Icon name="chevron-forward" size={14} color={colors.faint} />
              </View>
            ) : null}
            <View style={styles.actions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Call ${lead.name}`}
                hitSlop={4}
                onPress={startCall}
                style={[styles.action, { backgroundColor: colors.primarySoft }]}
              >
                <Icon name="call" size={18} color={colors.primary} />
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`WhatsApp ${lead.name}`}
                hitSlop={4}
                onPress={() => void openWhatsApp(lead.phone)}
                style={[styles.action, { backgroundColor: colors.successSoft }]}
              >
                <Icon name="logo-whatsapp" size={18} color={colors.whatsapp} />
              </Pressable>
            </View>
          </View>
        </View>
        <View style={styles.facts}>
          <FactCell
            icon="calendar-outline"
            label={overdue ? 'Follow-up overdue' : 'Next follow-up'}
            value={next ?? 'Not scheduled'}
            tone={overdue ? colors.danger : undefined}
          />
          {lead.stage ? (
            <FactCell
              icon="flag-outline"
              label="Stage"
              value={lead.stage}
              tone={stageTone(lead.stage).fg}
            />
          ) : null}
          {extra ? <FactCell icon={extra.icon} label={extra.label} value={extra.value} /> : null}
        </View>
      </Pressable>
    </SwipeRow>
  );
});

/** A compact lead for the Home "Recent leads" strip. */
export const LeadTile = memo(function LeadTile({ lead }: { lead: LeadRowData }) {
  const tone = temperatureTone(lead.temperature);
  const temperature = lead.temperature ? temperatureLabels[lead.temperature] : null;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => router.push({ pathname: '/lead/[id]', params: { id: lead.id } })}
      style={({ pressed }) => [styles.tile, pressed && styles.cardPressed]}
    >
      <View style={styles.tileTop}>
        <Avatar name={lead.name} tone={tone} size={34} />
        {temperature ? <Badge label={temperature} tone={tone} /> : null}
      </View>
      <Text numberOfLines={1} style={styles.tileModel}>
        {lead.model ?? 'Model not set'}
      </Text>
      <Text numberOfLines={1} style={styles.tileName}>
        {lead.name}
      </Text>
      <Text numberOfLines={1} style={styles.tileMeta}>
        {[lead.source, timeAgo(lead.updatedAt)].filter(Boolean).join(' · ')}
      </Text>
    </Pressable>
  );
});

// Shared with SwipeRow so the green Call strip behind the card has the same corners.
const CARD_RADIUS = radius.lg + 4;

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: CARD_RADIUS,
    padding: space.md + 2,
    gap: space.md,
    overflow: 'hidden',
  },
  cardPressed: { backgroundColor: colors.pressed },
  cardTop: { flexDirection: 'row', gap: space.md, alignItems: 'flex-start' },
  nameLine: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  cardName: { flexShrink: 1, color: colors.text, fontSize: font.heading, fontWeight: '700' },
  phoneLine: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  phone: { color: colors.text, fontSize: font.row, fontWeight: '500', letterSpacing: 0.3 },
  side: { alignItems: 'flex-end', gap: space.sm },
  updated: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  updatedText: { color: colors.muted, fontSize: font.label },
  actions: { flexDirection: 'row', gap: space.sm },
  action: {
    width: 42,
    height: 42,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  facts: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: space.md,
    gap: space.sm,
  },
  fact: { flex: 1, flexDirection: 'row', gap: 6, alignItems: 'flex-start', minWidth: 0 },
  factText: { flex: 1, minWidth: 0 },
  factLabel: { color: colors.muted, fontSize: font.caption },
  factValue: { color: colors.text, fontSize: font.label, fontWeight: '600', marginTop: 1 },
  tile: {
    width: 156,
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: space.md,
    gap: 3,
  },
  tileTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: space.xs,
  },
  tileModel: { color: colors.text, fontSize: font.row, fontWeight: '700' },
  tileName: { color: colors.muted, fontSize: font.label },
  tileMeta: { color: colors.faint, fontSize: font.caption },
  main: { flex: 1, minWidth: 0, gap: 2 },
  line: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: 2 },
  name: { color: colors.text, fontSize: font.body, fontWeight: '600' },
  meta: { flexShrink: 1, color: colors.muted, fontSize: font.small },
  when: { color: colors.faint, fontSize: font.label, fontWeight: '500' },
  overdue: { color: colors.danger },
});
