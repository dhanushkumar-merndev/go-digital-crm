import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Screen } from '@/components/screen';
import {
  createMobileLeadFollowup,
  createMobileTestDriveAppointment,
  fetchMobileLeadDetail,
  type MobileLeadDetail,
} from '@/lib/lead-detail';
import { colors } from '@/theme';

type ModalKind = 'followup' | 'testDrive' | null;

function dateTime(value: string | null) {
  if (!value) return 'Not scheduled';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Time unavailable'
    : new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function localDateInput() {
  const next = new Date(Date.now() + 24 * 60 * 60 * 1000);
  next.setHours(10, 0, 0, 0);
  const pad = (value: number) => value.toString().padStart(2, '0');
  return `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())} ${pad(next.getHours())}:${pad(next.getMinutes())}`;
}

function requestId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16);
    return (character === 'x' ? random : (random & 0x3) | 0x8).toString(16);
  });
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

function temperatureStyle(value: MobileLeadDetail['lead']['temperature']) {
  if (value === 'HOT') return { color: '#dc2626', backgroundColor: '#fef2f2' };
  if (value === 'WARM') return { color: '#b45309', backgroundColor: '#fffbeb' };
  return { color: '#2563eb', backgroundColor: '#eff6ff' };
}

export default function LeadDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [detail, setDetail] = useState<MobileLeadDetail>();
  const [error, setError] = useState(false);
  const [modal, setModal] = useState<ModalKind>(null);
  const [reason, setReason] = useState('Follow up on our discussion');
  const [dueAt, setDueAt] = useState(localDateInput);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string>();
  const [success, setSuccess] = useState<string>();
  const load = useCallback(async () => {
    if (!id) return;
    setError(false);
    try {
      setDetail(await fetchMobileLeadDetail(id));
    } catch {
      setError(true);
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);
  const callCustomer = () => {
    if (detail) void Linking.openURL(`tel:${detail.lead.phone.replace(/[^+\d]/g, '')}`);
  };
  const submit = async () => {
    if (!detail || !modal) return;
    const scheduled = new Date(dueAt.replace(' ', 'T'));
    if (Number.isNaN(scheduled.getTime()) || (modal === 'followup' && reason.trim().length < 3)) {
      setFormError('Enter the required information and a valid local date/time.');
      return;
    }
    setSaving(true);
    setFormError(undefined);
    try {
      if (modal === 'followup') {
        await createMobileLeadFollowup({
          detail,
          reason: reason.trim(),
          dueAt: scheduled.toISOString(),
          requestId: requestId(),
        });
        setSuccess('Follow-up scheduled successfully.');
      } else {
        await createMobileTestDriveAppointment({
          detail,
          scheduledAt: scheduled.toISOString(),
          requestId: requestId(),
        });
        setSuccess('Test drive appointment scheduled successfully.');
      }
      setModal(null);
      void load();
    } catch {
      setFormError('The action could not be saved. Check access and try again.');
    } finally {
      setSaving(false);
    }
  };
  const lead = detail?.lead;
  const nextFollowup = detail?.followups.find(
    (item) => item.status === 'OPEN' || item.status === 'OVERDUE',
  );
  const lastCall = detail?.calls[0];

  return (
    <Screen
      title="Customer detail"
      subtitle={lead ? lead.branch_name : 'Authorized customer context'}
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
            It may have moved outside your authorized scope. Tap to retry.
          </Text>
        </Pressable>
      ) : null}
      {detail && lead ? (
        <>
          <View style={styles.card}>
            <View style={styles.customerRow}>
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>{initials(lead.customer_name)}</Text>
              </View>
              <View style={styles.grow}>
                <View style={styles.nameRow}>
                  <Text style={styles.customerName}>{lead.customer_name}</Text>
                  {lead.temperature ? (
                    <Text style={[styles.temperature, temperatureStyle(lead.temperature)]}>
                      {lead.temperature}
                    </Text>
                  ) : null}
                </View>
                <Pressable onPress={callCustomer}>
                  <Text style={styles.phone}>{lead.phone}</Text>
                </Pressable>
                <Text style={styles.interested}>
                  Interested in {lead.interested_model ?? 'Not specified'}
                </Text>
              </View>
            </View>
            <View style={styles.divider} />
            <Text style={styles.source}>
              {lead.source} · {lead.branch_name}
            </Text>
            {lead.customer_id ? (
              <Pressable
                onPress={() =>
                  router.push({
                    pathname: '/customer/[id]',
                    params: { id: lead.customer_id as string },
                  })
                }
              >
                <Text style={styles.customerLink}>Open customer profile</Text>
              </Pressable>
            ) : null}
          </View>

          <View style={styles.actions}>
            <Action label="Call" enabled onPress={callCustomer} />
            <Action
              label="Follow-up"
              enabled={detail.access.can_followups}
              onPress={() => setModal('followup')}
            />
            <Action
              label="Calls"
              enabled={detail.access.can_calls && Boolean(detail.calls.length)}
              onPress={() =>
                lastCall && router.push({ pathname: '/call/[id]', params: { id: lastCall.id } })
              }
            />
            <Action
              label="Test drive"
              enabled={detail.access.can_appointments && Boolean(lead.customer_id)}
              onPress={() => setModal('testDrive')}
            />
          </View>

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Customer requirement</Text>
            <View style={styles.details}>
              <Detail label="Interested model" value={lead.interested_model ?? 'Not specified'} />
              <Detail label="Current stage" value={lead.lifecycle_status} />
              <Detail
                label="Work state"
                value={lead.work_state?.replaceAll('_', ' ') ?? 'In progress'}
              />
              <Detail label="Assigned to" value={lead.assigned_user_name ?? 'Unassigned'} />
            </View>
          </View>

          {detail.latest_ai_summary ? (
            <View style={styles.card}>
              <Text style={styles.aiTitle}>Previous call AI summary</Text>
              <Text style={styles.aiText}>{detail.latest_ai_summary}</Text>
              {lastCall ? (
                <Pressable
                  onPress={() =>
                    router.push({ pathname: '/call/[id]', params: { id: lastCall.id } })
                  }
                >
                  <Text style={styles.link}>Open call summary</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Follow-up</Text>
            {nextFollowup ? (
              <>
                <Text style={styles.followupReason}>{nextFollowup.reason}</Text>
                <Text style={styles.followupDetail}>
                  {dateTime(nextFollowup.due_at)} · {nextFollowup.assigned_user_name ?? 'You'}
                </Text>
              </>
            ) : (
              <Text style={styles.muted}>No open follow-up is scheduled.</Text>
            )}
            {success ? <Text style={styles.success}>{success}</Text> : null}
          </View>

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Timeline</Text>
            {detail.timeline.length ? (
              detail.timeline.map((item) => (
                <View key={item.id} style={styles.timelineRow}>
                  <View style={styles.timelineDot} />
                  <View style={styles.grow}>
                    <Text style={styles.timelineTitle}>{item.title}</Text>
                    {item.detail ? <Text style={styles.timelineDetail}>{item.detail}</Text> : null}
                  </View>
                  <Text style={styles.timelineTime}>{dateTime(item.occurred_at)}</Text>
                </View>
              ))
            ) : (
              <Text style={styles.muted}>No recent activity is available.</Text>
            )}
          </View>
        </>
      ) : null}
      <Modal
        visible={modal !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setModal(null)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modal}>
            <Text style={styles.modalTitle}>
              {modal === 'testDrive' ? 'Schedule test drive' : 'Schedule follow-up'}
            </Text>
            <Text style={styles.modalText}>
              {modal === 'testDrive'
                ? 'This creates an authorized Test Drive appointment.'
                : 'This creates an audited CRM follow-up assigned to you.'}
            </Text>
            {modal === 'followup' ? (
              <>
                <Text style={styles.inputLabel}>Reason</Text>
                <TextInput
                  value={reason}
                  onChangeText={setReason}
                  style={styles.input}
                  maxLength={240}
                  placeholder="Reason for follow-up"
                />
              </>
            ) : null}
            <Text style={styles.inputLabel}>
              {modal === 'testDrive' ? 'Appointment date and time' : 'Due date and time'}
            </Text>
            <TextInput
              value={dueAt}
              onChangeText={setDueAt}
              style={styles.input}
              autoCapitalize="none"
              placeholder="YYYY-MM-DD HH:mm"
            />
            {formError ? <Text style={styles.formError}>{formError}</Text> : null}
            <View style={styles.modalActions}>
              <Pressable style={styles.cancel} onPress={() => setModal(null)} disabled={saving}>
                <Text style={styles.cancelText}>Cancel</Text>
              </Pressable>
              <Pressable style={styles.save} onPress={() => void submit()} disabled={saving}>
                <Text style={styles.saveText}>{saving ? 'Saving…' : 'Save'}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
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
    backgroundColor: '#fee2e2',
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarText: { color: '#be123c', fontSize: 20, fontWeight: '800' },
  grow: { flex: 1 },
  nameRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 7 },
  customerName: { color: colors.navy, fontSize: 19, fontWeight: '800' },
  temperature: {
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
    fontSize: 10,
    fontWeight: '800',
  },
  phone: { color: colors.success, fontSize: 14, fontWeight: '700', marginTop: 5 },
  interested: { color: colors.text, fontSize: 12, fontWeight: '700', marginTop: 6 },
  divider: { height: 1, backgroundColor: colors.border },
  source: { color: colors.muted, fontSize: 11, fontWeight: '700' },
  customerLink: { color: colors.primary, fontSize: 12, fontWeight: '800' },
  actions: { flexDirection: 'row', gap: 8 },
  action: {
    flex: 1,
    minHeight: 54,
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
  detail: {
    width: '47%',
    borderLeftWidth: 2,
    borderLeftColor: '#dbeafe',
    paddingLeft: 8,
    minHeight: 44,
  },
  detailLabel: { color: colors.muted, fontSize: 10, fontWeight: '700' },
  detailValue: { color: colors.text, fontSize: 12, fontWeight: '800', marginTop: 4 },
  aiTitle: { color: '#7c3aed', fontSize: 17, fontWeight: '800' },
  aiText: { color: colors.text, fontSize: 13, lineHeight: 20 },
  link: { color: colors.primary, fontSize: 12, fontWeight: '800' },
  followupReason: { color: colors.text, fontWeight: '800', fontSize: 14 },
  followupDetail: { color: colors.muted, fontSize: 12 },
  success: { color: colors.success, fontSize: 12, fontWeight: '800' },
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
  timelineDetail: { color: colors.muted, fontSize: 11, marginTop: 2 },
  timelineTime: { color: colors.muted, fontSize: 9, maxWidth: 84, textAlign: 'right' },
  modalBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(15,23,42,0.4)' },
  modal: {
    backgroundColor: colors.card,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    padding: 20,
    gap: 10,
  },
  modalTitle: { color: colors.navy, fontSize: 19, fontWeight: '800' },
  modalText: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  inputLabel: { color: colors.text, fontSize: 12, fontWeight: '800', marginTop: 4 },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    minHeight: 44,
    paddingHorizontal: 11,
    color: colors.text,
    backgroundColor: '#fff',
  },
  formError: { color: colors.danger, fontSize: 12 },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 6 },
  cancel: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingVertical: 11,
    paddingHorizontal: 14,
  },
  cancelText: { color: colors.text, fontWeight: '800' },
  save: {
    backgroundColor: colors.primary,
    borderRadius: 10,
    paddingVertical: 11,
    paddingHorizontal: 14,
  },
  saveText: { color: 'white', fontWeight: '800' },
});
