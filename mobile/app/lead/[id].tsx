import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Screen } from '@/components/screen';
import {
  createMobileLeadFollowup,
  createMobileTestDrive,
  fetchCustomerMatches,
  fetchHandoffCandidates,
  fetchMobileLeadDetail,
  fetchMobileRole,
  fetchTestDriveVehicles,
  isValidRegistration,
  leadActionMessage,
  recordMobileLeadContact,
  resolveMobileLeadCustomer,
  sanitizeRegistration,
  transferMobileLeadToSales,
  type CustomerMatch,
  type HandoffCandidate,
  type MobileLeadDetail,
  type MobileRole,
  type TestDriveVehicle,
} from '@/lib/lead-detail';
import { colors } from '@/theme';

type ModalKind = 'followup' | null;

// Same audited defaults as the web customer-match dialog: editable, never silent.
const LINK_REASON = 'Same phone number; confirmed this is the same customer.';
const NO_MATCH_REASON = 'No exact phone or email match was found for this lead.';
const TRANSFER_NOTE = 'Qualified on call; customer ready for Sales.';
const intakeClosed = new Set(['Lost', 'Transferred to Sales']);

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

// Some activity rows carry only their event code (FOLLOWUP_COMPLETED).
function timelineTitle(title: string) {
  if (!/^[A-Z][A-Z0-9_]+$/.test(title)) return title;
  const words = title.toLowerCase().replaceAll('_', ' ').replace('followup', 'follow-up');
  return words.charAt(0).toUpperCase() + words.slice(1);
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
  const [role, setRole] = useState<MobileRole>(null);
  const [notice, setNotice] = useState<string>();
  const load = useCallback(async () => {
    if (!id) return;
    setError(false);
    try {
      const [nextDetail, nextRole] = await Promise.all([
        fetchMobileLeadDetail(id),
        fetchMobileRole(),
      ]);
      setDetail(nextDetail);
      setRole(nextRole);
    } catch {
      setError(true);
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);
  // The dialer opens first; the contact is then recorded exactly as the web
  // Call button records it, so a phone call moves a New lead to Contacted.
  const callCustomer = async () => {
    if (!detail) return;
    void Linking.openURL(`tel:${detail.lead.phone.replace(/[^+\d]/g, '')}`);
    try {
      const callerRole = role ?? (await fetchMobileRole());
      if (!callerRole) throw new Error('PERMISSION_DENIED');
      if (callerRole !== role) setRole(callerRole);
      if (callerRole === 'telecaller' && intakeClosed.has(detail.lead.lifecycle_status)) return;
      await recordMobileLeadContact(callerRole, detail.lead.id);
      setNotice(undefined);
      void load();
    } catch (contactError) {
      setNotice(leadActionMessage(contactError, 'The call could not be recorded on the lead.'));
    }
  };
  const [transferOpen, setTransferOpen] = useState(false);
  const [testDriveOpen, setTestDriveOpen] = useState(false);
  const submit = async () => {
    if (!detail || !modal) return;
    const scheduled = new Date(dueAt.replace(' ', 'T'));
    if (Number.isNaN(scheduled.getTime()) || reason.trim().length < 3) {
      setFormError('Enter the required information and a valid local date/time.');
      return;
    }
    setSaving(true);
    setFormError(undefined);
    try {
      await createMobileLeadFollowup({
        detail,
        reason: reason.trim(),
        dueAt: scheduled.toISOString(),
        requestId: requestId(),
      });
      setSuccess('Follow-up scheduled successfully.');
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
            It did not load, or it is outside your scope. Tap to retry.
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
                <Pressable onPress={() => void callCustomer()}>
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
            <Action label="Call" enabled onPress={() => void callCustomer()} />
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
            {role === 'telecaller' ? (
              <Action
                label="Transfer"
                enabled={detail.access.can_update && !intakeClosed.has(lead.lifecycle_status)}
                onPress={() => setTransferOpen(true)}
              />
            ) : (
              <Action
                label="Test drive"
                enabled={detail.access.can_appointments && Boolean(lead.customer_id)}
                onPress={() => setTestDriveOpen(true)}
              />
            )}
          </View>
          {notice ? <Text style={styles.notice}>{notice}</Text> : null}

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

          {detail.calls.length ? (
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Recent calls</Text>
              {detail.calls.slice(0, 5).map((call) => (
                <Pressable
                  key={call.id}
                  style={styles.timelineRow}
                  onPress={() => router.push({ pathname: '/call/[id]', params: { id: call.id } })}
                >
                  <View style={styles.timelineDot} />
                  <View style={styles.grow}>
                    <Text style={styles.timelineTitle}>
                      {(call.outcome ?? call.status).replaceAll('_', ' ')}
                    </Text>
                    <Text style={styles.timelineDetail}>
                      {call.duration_seconds
                        ? `${Math.floor(call.duration_seconds / 60)}m ${(call.duration_seconds % 60).toString().padStart(2, '0')}s · `
                        : ''}
                      Transcript & summary
                    </Text>
                  </View>
                  <Text style={styles.timelineTime}>{dateTime(call.started_at)}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Timeline</Text>
            {detail.timeline.length ? (
              detail.timeline.map((item) => (
                <View key={item.id} style={styles.timelineRow}>
                  <View style={styles.timelineDot} />
                  <View style={styles.grow}>
                    <Text style={styles.timelineTitle}>{timelineTitle(item.title)}</Text>
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
            <Text style={styles.modalTitle}>Schedule follow-up</Text>
            <Text style={styles.modalText}>
              This creates an audited CRM follow-up assigned to you.
            </Text>
            <Text style={styles.inputLabel}>Reason</Text>
            <TextInput
              value={reason}
              onChangeText={setReason}
              style={styles.input}
              maxLength={240}
              placeholder="Reason for follow-up"
            />
            <Text style={styles.inputLabel}>Due date and time</Text>
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
      {detail && transferOpen ? (
        <TransferSheet
          detail={detail}
          onClose={() => setTransferOpen(false)}
          onReload={load}
          onTransferred={(name) => {
            setTransferOpen(false);
            setSuccess(`Transferred to ${name}.`);
            void load();
          }}
        />
      ) : null}
      {detail && testDriveOpen ? (
        <TestDriveSheet
          detail={detail}
          onClose={() => setTestDriveOpen(false)}
          onScheduled={() => {
            setTestDriveOpen(false);
            setSuccess('Test drive scheduled successfully.');
            void load();
          }}
        />
      ) : null}
    </Screen>
  );
}

// Mirrors the web Schedule test drive dialog: an available vehicle from the
// lead's branch, its registration, and the time. Duration defaults to 60 min.
function TestDriveSheet({
  detail,
  onClose,
  onScheduled,
}: {
  detail: MobileLeadDetail;
  onClose: () => void;
  onScheduled: () => void;
}) {
  const [vehicles, setVehicles] = useState<TestDriveVehicle[]>();
  const [vehicle, setVehicle] = useState<string | null>(null);
  const [registration, setRegistration] = useState('');
  const [scheduledAt, setScheduledAt] = useState(localDateInput);
  const [busy, setBusy] = useState(false);
  const [sheetError, setSheetError] = useState<string>();
  const [request] = useState(requestId);
  useEffect(() => {
    let active = true;
    fetchTestDriveVehicles(detail.lead.branch_id)
      .then((found) => {
        if (!active) return;
        setVehicles(found);
        setVehicle(found[0]?.stock_unit_id ?? null);
      })
      .catch((loadError) => {
        if (active) setSheetError(leadActionMessage(loadError, 'Vehicles could not load.'));
      });
    return () => {
      active = false;
    };
  }, [detail.lead.branch_id]);
  const save = async () => {
    const scheduled = new Date(scheduledAt.replace(' ', 'T'));
    if (!vehicle) {
      setSheetError('Pick a vehicle.');
      return;
    }
    if (!isValidRegistration(registration)) {
      setSheetError('Enter the registration: 4–24 letters, numbers, spaces or hyphens.');
      return;
    }
    if (Number.isNaN(scheduled.getTime())) {
      setSheetError('Enter a valid local date/time.');
      return;
    }
    setBusy(true);
    setSheetError(undefined);
    try {
      await createMobileTestDrive({
        leadId: detail.lead.id,
        stockUnitId: vehicle,
        scheduledAt: scheduled.toISOString(),
        registration,
        requestId: request,
      });
      onScheduled();
    } catch (saveError) {
      setSheetError(leadActionMessage(saveError, 'The test drive could not be scheduled.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior="padding" style={styles.modalBackdrop}>
        <View style={styles.modal}>
          <Text style={styles.modalTitle}>Schedule test drive</Text>
          <Text style={styles.modalText}>
            Pick an available vehicle from {detail.lead.branch_name}.
          </Text>
          {!vehicles && !sheetError ? <ActivityIndicator color={colors.primary} /> : null}
          {vehicles && !vehicles.length ? (
            <Text style={styles.muted}>No vehicle is available for test drives here.</Text>
          ) : null}
          {vehicles?.length ? (
            <ScrollView style={styles.choices}>
              {vehicles.map((item) => (
                <Choice
                  key={item.stock_unit_id}
                  selected={vehicle === item.stock_unit_id}
                  title={`${item.brand_name} ${item.model_name}`}
                  detail={[item.variant_name, item.color, item.vin].filter(Boolean).join(' · ')}
                  onPress={() => setVehicle(item.stock_unit_id)}
                />
              ))}
            </ScrollView>
          ) : null}
          <Text style={styles.inputLabel}>Vehicle registration</Text>
          <TextInput
            value={registration}
            onChangeText={(value) => setRegistration(sanitizeRegistration(value))}
            style={styles.input}
            autoCapitalize="characters"
            placeholder="KA 01 TD 1234"
          />
          <Text style={styles.inputLabel}>Date and time</Text>
          <TextInput
            value={scheduledAt}
            onChangeText={setScheduledAt}
            style={styles.input}
            autoCapitalize="none"
            placeholder="YYYY-MM-DD HH:mm"
          />
          {sheetError ? <Text style={styles.formError}>{sheetError}</Text> : null}
          <View style={styles.modalActions}>
            <Pressable style={styles.cancel} onPress={onClose} disabled={busy}>
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[styles.save, (busy || !vehicle) && styles.actionDisabled]}
              onPress={() => void save()}
              disabled={busy || !vehicle}
            >
              <Text style={styles.saveText}>{busy ? 'Saving…' : 'Schedule'}</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// Qualify & Transfer: link the customer first when the lead has none (the
// handoff requires one), then pick the Sales Consultant.
function TransferSheet({
  detail,
  onClose,
  onReload,
  onTransferred,
}: {
  detail: MobileLeadDetail;
  onClose: () => void;
  onReload: () => Promise<void>;
  onTransferred: (consultant: string) => void;
}) {
  const needsCustomer = !detail.lead.customer_id;
  const [matches, setMatches] = useState<CustomerMatch[]>();
  const [choice, setChoice] = useState<string>('NEW');
  const [reason, setReason] = useState(NO_MATCH_REASON);
  const [candidates, setCandidates] = useState<HandoffCandidate[]>();
  const [consultant, setConsultant] = useState<string | null>(null);
  const [note, setNote] = useState(TRANSFER_NOTE);
  const [busy, setBusy] = useState(false);
  const [sheetError, setSheetError] = useState<string>();
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        if (needsCustomer) {
          const found = await fetchCustomerMatches(detail.lead.id);
          if (!active) return;
          setMatches(found);
          if (found[0]) {
            setChoice(found[0].customer_id);
            setReason(LINK_REASON);
          }
        } else {
          const found = await fetchHandoffCandidates(detail.lead.id);
          if (!active) return;
          setCandidates(found);
          setConsultant(
            found.find((item) => item.recommended)?.user_id ?? found[0]?.user_id ?? null,
          );
        }
      } catch (loadError) {
        if (active) setSheetError(leadActionMessage(loadError, 'Could not load the next step.'));
      }
    })();
    return () => {
      active = false;
    };
  }, [detail.lead.id, needsCustomer]);
  const choose = (value: string) => {
    setChoice(value);
    setReason(value === 'NEW' ? (matches?.length ? '' : NO_MATCH_REASON) : LINK_REASON);
  };
  const linkCustomer = async () => {
    if (reason.trim().length < 3) {
      setSheetError('Enter a reason of at least 3 characters.');
      return;
    }
    setBusy(true);
    setSheetError(undefined);
    try {
      await resolveMobileLeadCustomer({
        detail,
        customerId: choice === 'NEW' ? null : choice,
        reason: reason.trim(),
        requestId: requestId(),
      });
      await onReload();
    } catch (linkError) {
      setSheetError(leadActionMessage(linkError, 'The customer could not be linked.'));
    } finally {
      setBusy(false);
    }
  };
  const transfer = async () => {
    if (note.trim().length < 3) {
      setSheetError('Enter a transfer note.');
      return;
    }
    setBusy(true);
    setSheetError(undefined);
    try {
      await transferMobileLeadToSales({
        leadId: detail.lead.id,
        consultantId: consultant,
        note: note.trim(),
        requestId: requestId(),
      });
      onTransferred(candidates?.find((item) => item.user_id === consultant)?.full_name ?? 'Sales');
    } catch (transferError) {
      setSheetError(leadActionMessage(transferError, 'The lead could not be transferred.'));
    } finally {
      setBusy(false);
    }
  };
  const loading = needsCustomer ? !matches : !candidates;
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior="padding" style={styles.modalBackdrop}>
        <View style={styles.modal}>
          <Text style={styles.modalTitle}>
            {needsCustomer ? 'Link the customer' : 'Transfer to Sales'}
          </Text>
          <Text style={styles.modalText}>
            {needsCustomer
              ? 'Sales needs the customer record. Link a matching customer or create a new one.'
              : 'Choose the Sales Consultant who takes over this lead.'}
          </Text>
          {loading && !sheetError ? <ActivityIndicator color={colors.primary} /> : null}
          {needsCustomer && matches ? (
            <ScrollView style={styles.choices}>
              {matches.map((match) => (
                <Choice
                  key={match.customer_id}
                  selected={choice === match.customer_id}
                  title={match.full_name}
                  detail={[
                    match.masked_phone,
                    `${match.lead_count} enquir${match.lead_count === 1 ? 'y' : 'ies'}`,
                    match.latest_interested_model,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                  onPress={() => choose(match.customer_id)}
                />
              ))}
              <Choice
                selected={choice === 'NEW'}
                title="Create a new customer"
                detail={`${detail.lead.customer_name} · ${detail.lead.phone}`}
                onPress={() => choose('NEW')}
              />
            </ScrollView>
          ) : null}
          {!needsCustomer && candidates ? (
            <ScrollView style={styles.choices}>
              {candidates.map((candidate) => (
                <Choice
                  key={candidate.user_id}
                  selected={consultant === candidate.user_id}
                  title={`${candidate.full_name}${candidate.recommended ? ' · Recommended' : ''}`}
                  detail={`${candidate.open_leads} open · ${candidate.hot_leads} hot`}
                  onPress={() => setConsultant(candidate.user_id)}
                />
              ))}
            </ScrollView>
          ) : null}
          {!loading ? (
            <>
              <Text style={styles.inputLabel}>{needsCustomer ? 'Reason' : 'Transfer note'}</Text>
              <TextInput
                value={needsCustomer ? reason : note}
                onChangeText={needsCustomer ? setReason : setNote}
                style={styles.input}
                maxLength={500}
                placeholder={needsCustomer ? 'Why this customer' : 'Note for Sales'}
              />
            </>
          ) : null}
          {sheetError ? <Text style={styles.formError}>{sheetError}</Text> : null}
          <View style={styles.modalActions}>
            <Pressable style={styles.cancel} onPress={onClose} disabled={busy}>
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[styles.save, (busy || loading) && styles.actionDisabled]}
              onPress={() => void (needsCustomer ? linkCustomer() : transfer())}
              disabled={busy || loading}
            >
              <Text style={styles.saveText}>
                {busy ? 'Saving…' : needsCustomer ? 'Link and continue' : 'Transfer'}
              </Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function Choice({
  selected,
  title,
  detail,
  onPress,
}: {
  selected: boolean;
  title: string;
  detail: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={[styles.choice, selected && styles.choiceSelected]}
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
    >
      <Text style={styles.choiceTitle}>{title}</Text>
      {detail ? <Text style={styles.choiceDetail}>{detail}</Text> : null}
    </Pressable>
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
  notice: { color: colors.danger, fontSize: 12, fontWeight: '700' },
  choices: { maxHeight: 260 },
  choice: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 11,
    marginBottom: 8,
  },
  choiceSelected: { borderColor: colors.primary, backgroundColor: '#eff6ff' },
  choiceTitle: { color: colors.text, fontSize: 13, fontWeight: '800' },
  choiceDetail: { color: colors.muted, fontSize: 11, marginTop: 3 },
});
