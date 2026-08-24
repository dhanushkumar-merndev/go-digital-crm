import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { Screen } from '@/components/screen';
import { fetchMobileCustomerDetail, type MobileCustomerDetail } from '@/lib/customer-detail';
import { colors } from '@/theme';

function dateTime(value: string | null | undefined) {
  if (!value) return 'Not scheduled';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Time unavailable'
    : new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function initials(name: string) {
  return name
    .split(' ')
    .filter(Boolean)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function humanize(value: string) {
  return value
    .replaceAll('_', ' ')
    .toLowerCase()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function currency(value: number | null) {
  if (value === null) return '—';
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(value);
}

export default function CustomerDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [detail, setDetail] = useState<MobileCustomerDetail>();
  const [error, setError] = useState(false);
  const load = useCallback(async () => {
    if (!id) return;
    setError(false);
    try {
      setDetail(await fetchMobileCustomerDetail(id));
    } catch {
      setError(true);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const nextFollowup = useMemo(
    () => detail?.followups.find((item) => item.status === 'OPEN' || item.status === 'OVERDUE'),
    [detail],
  );
  const latestCall = detail?.calls[0];
  const opportunity = detail?.current_opportunity;
  const phone = detail?.customer.primary_phone?.replace(/[^+\d]/g, '');

  return (
    <Screen
      title="Customer detail"
      subtitle={opportunity?.branch_name ?? 'Authorized customer context'}
      action={
        <Pressable onPress={() => router.back()}>
          <Text style={styles.back}>Back</Text>
        </Pressable>
      }
    >
      {!detail && !error ? (
        <View style={styles.loading}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : null}
      {error ? (
        <Pressable style={styles.error} onPress={() => void load()}>
          <Text style={styles.errorTitle}>Customer detail is unavailable</Text>
          <Text style={styles.errorText}>
            This customer may be outside your authorized scope. Tap to retry.
          </Text>
        </Pressable>
      ) : null}
      {detail ? (
        <>
          <View style={styles.card}>
            <View style={styles.customerRow}>
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>{initials(detail.customer.full_name)}</Text>
              </View>
              <View style={styles.grow}>
                <Text style={styles.customerName}>{detail.customer.full_name}</Text>
                {detail.customer.primary_phone ? (
                  <Text style={styles.phone}>{detail.customer.primary_phone}</Text>
                ) : (
                  <Text style={styles.muted}>Phone not available</Text>
                )}
                {detail.customer.primary_email ? (
                  <Text style={styles.email}>{detail.customer.primary_email}</Text>
                ) : null}
              </View>
            </View>
            {opportunity ? (
              <View style={styles.opportunityStrip}>
                <Text style={styles.opportunityLabel}>Active opportunity</Text>
                <Text style={styles.opportunityValue}>
                  {opportunity.interested_model ?? 'Model not specified'} ·{' '}
                  {humanize(opportunity.lifecycle_status)}
                </Text>
              </View>
            ) : null}
          </View>

          <View style={styles.actions}>
            <Action
              label="Call"
              enabled={Boolean(phone)}
              onPress={() => phone && void Linking.openURL(`tel:${phone}`)}
            />
            <Action
              label="Open lead"
              enabled={Boolean(opportunity?.id)}
              onPress={() =>
                opportunity &&
                router.push({ pathname: '/lead/[id]', params: { id: opportunity.id } })
              }
            />
            <Action
              label="Latest call"
              enabled={Boolean(latestCall)}
              onPress={() =>
                latestCall && router.push({ pathname: '/call/[id]', params: { id: latestCall.id } })
              }
            />
          </View>

          {opportunity ? (
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Customer requirement</Text>
              <View style={styles.details}>
                <Detail
                  label="Interested model"
                  value={opportunity.interested_model ?? 'Not specified'}
                />
                <Detail label="Current stage" value={humanize(opportunity.lifecycle_status)} />
                <Detail
                  label="Assigned to"
                  value={opportunity.assigned_user_name ?? 'Unassigned'}
                />
                <Detail label="Lead source" value={opportunity.source} />
              </View>
            </View>
          ) : null}

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Next action</Text>
            {nextFollowup ? (
              <>
                <Text style={styles.actionTitle}>{nextFollowup.reason}</Text>
                <Text style={styles.muted}>
                  {dateTime(nextFollowup.due_at)} ·{' '}
                  {nextFollowup.assigned_user_name ?? 'Assigned user'}
                </Text>
                {nextFollowup.lead_id ? (
                  <Pressable
                    onPress={() =>
                      router.push({
                        pathname: '/lead/[id]',
                        params: { id: nextFollowup.lead_id as string },
                      })
                    }
                  >
                    <Text style={styles.link}>Open lead to update follow-up</Text>
                  </Pressable>
                ) : null}
              </>
            ) : (
              <Text style={styles.muted}>No open follow-up is scheduled.</Text>
            )}
          </View>

          {detail.appointments.length || detail.quotations.length || detail.bookings.length ? (
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Sales progress</Text>
              {detail.appointments[0] ? (
                <Detail
                  label={detail.appointments[0].appointment_type}
                  value={`${humanize(detail.appointments[0].status)} · ${dateTime(detail.appointments[0].scheduled_at)}`}
                />
              ) : null}
              {detail.quotations[0] ? (
                <Detail
                  label={`Quotation ${detail.quotations[0].quotation_number}`}
                  value={`${humanize(detail.quotations[0].status)} · ${currency(detail.quotations[0].total_amount)}`}
                />
              ) : null}
              {detail.bookings[0] ? (
                <Detail
                  label={`Booking ${detail.bookings[0].booking_number}`}
                  value={`${humanize(detail.bookings[0].status)} · ${currency(detail.bookings[0].total_value)}`}
                />
              ) : null}
            </View>
          ) : null}

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Recent activity</Text>
            {detail.timeline.slice(0, 8).map((item) => (
              <View key={item.id} style={styles.timelineRow}>
                <View style={styles.timelineDot} />
                <View style={styles.grow}>
                  <Text style={styles.timelineTitle}>{humanize(item.activity_type)}</Text>
                  {item.actor_name ? <Text style={styles.muted}>{item.actor_name}</Text> : null}
                </View>
                <Text style={styles.timelineTime}>{dateTime(item.occurred_at)}</Text>
              </View>
            ))}
            {!detail.timeline.length ? (
              <Text style={styles.muted}>No recent activity is available.</Text>
            ) : null}
          </View>
        </>
      ) : null}
    </Screen>
  );
}

function Action({
  label,
  enabled,
  onPress,
}: {
  label: string;
  enabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={[styles.action, !enabled && styles.actionDisabled]}
      disabled={!enabled}
      onPress={onPress}
    >
      <Text style={[styles.actionText, !enabled && styles.actionTextDisabled]}>{label}</Text>
    </Pressable>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detail}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  back: { color: colors.primary, fontWeight: '700' },
  loading: { padding: 36, alignItems: 'center' },
  error: {
    borderColor: '#fecaca',
    borderWidth: 1,
    backgroundColor: '#fef2f2',
    borderRadius: 14,
    padding: 16,
  },
  errorTitle: { color: '#991b1b', fontWeight: '800' },
  errorText: { color: '#b91c1c', fontSize: 12, marginTop: 4 },
  card: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 16,
    padding: 15,
    gap: 11,
  },
  customerRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  avatar: {
    width: 62,
    height: 62,
    borderRadius: 31,
    backgroundColor: '#dbeafe',
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarText: { color: colors.primary, fontSize: 20, fontWeight: '800' },
  grow: { flex: 1 },
  customerName: { color: colors.navy, fontSize: 19, fontWeight: '800' },
  phone: { color: colors.success, fontSize: 14, fontWeight: '700', marginTop: 5 },
  email: { color: colors.muted, fontSize: 12, marginTop: 4 },
  opportunityStrip: { borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 11, gap: 3 },
  opportunityLabel: {
    color: colors.muted,
    fontSize: 10,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  opportunityValue: { color: colors.text, fontSize: 13, fontWeight: '800' },
  actions: { flexDirection: 'row', gap: 8 },
  action: {
    flex: 1,
    minHeight: 50,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 13,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  actionDisabled: { opacity: 0.45 },
  actionText: { color: colors.primary, fontSize: 11, fontWeight: '800', textAlign: 'center' },
  actionTextDisabled: { color: colors.muted },
  sectionTitle: { color: colors.navy, fontSize: 17, fontWeight: '800' },
  details: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  detail: { borderLeftWidth: 2, borderLeftColor: '#dbeafe', paddingLeft: 8, minHeight: 42, gap: 3 },
  detailLabel: { color: colors.muted, fontSize: 10, fontWeight: '700' },
  detailValue: { color: colors.text, fontSize: 12, fontWeight: '800' },
  actionTitle: { color: colors.text, fontWeight: '800', fontSize: 14 },
  link: { color: colors.primary, fontSize: 12, fontWeight: '800', marginTop: 3 },
  muted: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  timelineRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingVertical: 7 },
  timelineDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: colors.primary,
    marginTop: 5,
  },
  timelineTitle: { color: colors.text, fontSize: 13, fontWeight: '800' },
  timelineTime: { color: colors.muted, fontSize: 9, maxWidth: 84, textAlign: 'right' },
});
