import { router } from 'expo-router';
import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SwipeRow } from '@/components/swipe-row';
import { Avatar, Badge } from '@/components/ui/basics';
import { RowIcon, RowIcons, RowPressable } from '@/components/ui/row';
import { useCallFlow } from '@/features/call-flow/call-flow';
import { openWhatsApp } from '@/lib/contact';
import { colors, font, space, stageTone, temperatureTone } from '@/theme';

export type LeadRowData = {
  id: string;
  name: string;
  phone: string;
  model: string | null;
  source: string;
  stage: string | null;
  temperature: string | null;
  nextFollowupAt: string | null;
};

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

const styles = StyleSheet.create({
  main: { flex: 1, minWidth: 0, gap: 2 },
  line: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: 2 },
  name: { color: colors.text, fontSize: font.body, fontWeight: '600' },
  meta: { flexShrink: 1, color: colors.muted, fontSize: font.small },
  when: { color: colors.faint, fontSize: font.label, fontWeight: '500' },
  overdue: { color: colors.danger },
});
