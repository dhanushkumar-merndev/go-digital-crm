import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, View } from 'react-native';
import { Chip, PrimaryButton } from '@/components/ui/basics';
import { Icon } from '@/components/ui/icon';
import { PressableScale } from '@/components/ui/pressable-scale';
import { Sheet } from '@/components/ui/sheet';
import { WhenPicker } from '@/components/ui/when-picker';
import { followupReasons } from '@/features/call-flow/call-flow';
import {
  createMobileTestDrive,
  fetchCustomerMatches,
  fetchHandoffCandidates,
  fetchTestDriveVehicles,
  isValidRegistration,
  leadActionMessage,
  leadTemperatures,
  resolveMobileLeadCustomer,
  sanitizeRegistration,
  setMobileLeadTemperature,
  transferMobileLeadToSales,
  type CustomerMatch,
  type HandoffCandidate,
  type LeadTemperature,
  type MobileLeadDetail,
  type TestDriveVehicle,
} from '@/lib/lead-detail';
import { newRequestId, setLeadNextFollowup } from '@/lib/work-actions';
import { colors, font, radius, space, temperatureTone } from '@/theme';

// Same audited defaults as the web customer-match dialog: editable, never silent.
const LINK_REASON = 'Same phone number; confirmed this is the same customer.';
const NO_MATCH_REASON = 'No exact phone or email match was found for this lead.';
const TRANSFER_NOTE = 'Qualified on call; customer ready for Sales.';

function tomorrowAt(hour: number) {
  const next = new Date();
  next.setDate(next.getDate() + 1);
  next.setHours(hour, 0, 0, 0);
  return next;
}

export function FollowupSheet({
  detail,
  initial,
  onClose,
  onSaved,
}: {
  detail: MobileLeadDetail;
  initial?: { reason: string; dueAt: string };
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [reason, setReason] = useState(initial?.reason ?? followupReasons[0]);
  const [dueAt, setDueAt] = useState(() => (initial ? new Date(initial.dueAt) : tomorrowAt(10)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await setLeadNextFollowup({ leadId: detail.lead.id, reason, dueAt });
      onSaved(result === 'moved' ? 'Follow-up moved.' : 'Follow-up set.');
    } catch (saveError) {
      setError(leadActionMessage(saveError, 'The follow-up could not be saved.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      title={initial ? 'Change follow-up' : 'Set follow-up'}
      subtitle={detail.lead.customer_name}
      onClose={onClose}
      footer={
        <PrimaryButton
          label="Save"
          icon="checkmark"
          busy={busy}
          onPress={() => void save()}
          style={styles.grow}
        />
      }
    >
      <Text style={styles.label}>Reason</Text>
      <View style={styles.wrap}>
        {(followupReasons as readonly string[])
          .concat(
            initial && !followupReasons.includes(initial.reason as (typeof followupReasons)[number])
              ? [initial.reason]
              : [],
          )
          .map((item) => (
            <Chip
              key={item}
              label={item}
              selected={reason === item}
              onPress={() => setReason(item)}
            />
          ))}
      </View>
      <Text style={styles.label}>When</Text>
      <WhenPicker value={dueAt} onChange={setDueAt} />
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </Sheet>
  );
}

const temperatureCopy: Record<LeadTemperature, string> = {
  HOT: 'Ready to buy; intent confirmed on a call',
  WARM: 'Interested, not yet committed',
  COLD: 'Enquiry logged, little engagement yet',
  DORMANT: 'Do not disturb: no marketing messages',
};

export function TemperatureSheet({
  detail,
  onClose,
  onSaved,
}: {
  detail: MobileLeadDetail;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [busy, setBusy] = useState<LeadTemperature>();
  const [error, setError] = useState<string>();
  const choose = async (temperature: LeadTemperature) => {
    if (temperature === detail.lead.temperature) return onClose();
    setBusy(temperature);
    setError(undefined);
    try {
      await setMobileLeadTemperature({ lead: detail.lead, temperature });
      onSaved(`Marked ${temperature.toLowerCase()}.`);
    } catch (saveError) {
      setError(leadActionMessage(saveError, 'The temperature could not be changed.'));
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <Sheet title="Buying intent" subtitle={detail.lead.customer_name} onClose={onClose}>
      {leadTemperatures.map((item) => {
        const tone = temperatureTone(item);
        const selected = detail.lead.temperature === item;
        return (
          <PressableScale
            key={item}
            onPress={() => void choose(item)}
            disabled={Boolean(busy)}
            style={[styles.option, selected && { borderColor: tone.fg, backgroundColor: tone.bg }]}
          >
            <View style={[styles.dot, { backgroundColor: tone.fg }]} />
            <View style={styles.grow}>
              <Text style={styles.optionTitle}>{item.charAt(0) + item.slice(1).toLowerCase()}</Text>
              <Text style={styles.optionDetail}>{temperatureCopy[item]}</Text>
            </View>
            {busy === item ? (
              <ActivityIndicator color={tone.fg} />
            ) : selected ? (
              <Icon name="checkmark-circle" size={22} color={tone.fg} />
            ) : null}
          </PressableScale>
        );
      })}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </Sheet>
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
    <PressableScale
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      scaleTo={0.98}
      style={[styles.option, selected && styles.optionSelected]}
    >
      <Icon
        name={selected ? 'radio-button-on' : 'radio-button-off'}
        size={22}
        color={selected ? colors.primary : colors.faint}
      />
      <View style={styles.grow}>
        <Text style={styles.optionTitle}>{title}</Text>
        {detail ? <Text style={styles.optionDetail}>{detail}</Text> : null}
      </View>
    </PressableScale>
  );
}

// Mirrors the web Schedule test drive dialog: an available vehicle from the
// lead's branch, its registration, and the time. Duration defaults to 60 min.
export function TestDriveSheet({
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
  const [scheduledAt, setScheduledAt] = useState(() => tomorrowAt(11));
  const [allVehicles, setAllVehicles] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [request] = useState(newRequestId);
  useEffect(() => {
    let active = true;
    fetchTestDriveVehicles(detail.lead.branch_id)
      .then((found) => {
        if (!active) return;
        setVehicles(found);
        setVehicle(found[0]?.stock_unit_id ?? null);
      })
      .catch((loadError) => {
        if (active) setError(leadActionMessage(loadError, 'Vehicles could not load.'));
      });
    return () => {
      active = false;
    };
  }, [detail.lead.branch_id]);
  const save = async () => {
    if (!vehicle) return setError('Pick a vehicle.');
    if (!isValidRegistration(registration)) {
      return setError('Enter the registration: 4–24 letters, numbers, spaces or hyphens.');
    }
    setBusy(true);
    setError(undefined);
    try {
      await createMobileTestDrive({
        leadId: detail.lead.id,
        stockUnitId: vehicle,
        scheduledAt: scheduledAt.toISOString(),
        registration,
        requestId: request,
      });
      onScheduled();
    } catch (saveError) {
      setError(leadActionMessage(saveError, 'The test drive could not be scheduled.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      title="Schedule test drive"
      subtitle={`${detail.lead.customer_name} · ${detail.lead.branch_name}`}
      onClose={onClose}
      footer={
        <PrimaryButton
          label="Schedule"
          icon="car-sport"
          busy={busy}
          disabled={!vehicle}
          onPress={() => void save()}
          style={styles.grow}
        />
      }
    >
      <Text style={styles.label}>Vehicle</Text>
      {!vehicles && !error ? <ActivityIndicator color={colors.primary} /> : null}
      {vehicles && !vehicles.length ? (
        <Text style={styles.muted}>No vehicle is available for test drives here.</Text>
      ) : null}
      {/* Three cars keep the time and registration in reach; the rest on request. */}
      {vehicles
        ?.filter((item, index) => allVehicles || index < 3 || item.stock_unit_id === vehicle)
        .map((item) => (
          <Choice
            key={item.stock_unit_id}
            selected={vehicle === item.stock_unit_id}
            title={`${item.brand_name} ${item.model_name}`}
            detail={[item.variant_name, item.color, item.vin].filter(Boolean).join(' · ')}
            onPress={() => setVehicle(item.stock_unit_id)}
          />
        ))}
      {vehicles && vehicles.length > 3 && !allVehicles ? (
        <PressableScale onPress={() => setAllVehicles(true)} style={styles.more}>
          <Text style={styles.moreText}>Show {vehicles.length - 3} more</Text>
          <Icon name="chevron-down" size={16} color={colors.primary} />
        </PressableScale>
      ) : null}
      <Text style={styles.label}>Registration</Text>
      <TextInput
        value={registration}
        onChangeText={(value) => setRegistration(sanitizeRegistration(value))}
        style={styles.input}
        autoCapitalize="characters"
        placeholder="KA 01 TD 1234"
        placeholderTextColor={colors.faint}
      />
      <Text style={styles.label}>When</Text>
      <WhenPicker value={scheduledAt} onChange={setScheduledAt} />
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </Sheet>
  );
}

// Qualify & Transfer: link the customer first when the lead has none (the
// handoff requires one), then pick the Sales Consultant.
export function TransferSheet({
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
  const [error, setError] = useState<string>();
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
        if (active) setError(leadActionMessage(loadError, 'Could not load the next step.'));
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
    if (reason.trim().length < 3) return setError('Enter a reason of at least 3 characters.');
    setBusy(true);
    setError(undefined);
    try {
      await resolveMobileLeadCustomer({
        detail,
        customerId: choice === 'NEW' ? null : choice,
        reason: reason.trim(),
        requestId: newRequestId(),
      });
      await onReload();
    } catch (linkError) {
      setError(leadActionMessage(linkError, 'The customer could not be linked.'));
    } finally {
      setBusy(false);
    }
  };
  const transfer = async () => {
    if (note.trim().length < 3) return setError('Enter a transfer note.');
    setBusy(true);
    setError(undefined);
    try {
      await transferMobileLeadToSales({
        leadId: detail.lead.id,
        consultantId: consultant,
        note: note.trim(),
        requestId: newRequestId(),
      });
      onTransferred(candidates?.find((item) => item.user_id === consultant)?.full_name ?? 'Sales');
    } catch (transferError) {
      setError(leadActionMessage(transferError, 'The lead could not be transferred.'));
    } finally {
      setBusy(false);
    }
  };
  const loading = needsCustomer ? !matches : !candidates;
  return (
    <Sheet
      title={needsCustomer ? 'Step 1 · Link customer' : 'Transfer to Sales'}
      subtitle={
        needsCustomer
          ? 'Sales needs the customer record. Pick the match or create a new one.'
          : 'Who takes over this lead?'
      }
      onClose={onClose}
      footer={
        <PrimaryButton
          label={needsCustomer ? 'Link and continue' : 'Transfer'}
          icon={needsCustomer ? 'link' : 'send'}
          busy={busy}
          disabled={loading}
          onPress={() => void (needsCustomer ? linkCustomer() : transfer())}
          style={styles.grow}
        />
      }
    >
      {loading && !error ? <ActivityIndicator color={colors.primary} /> : null}
      {needsCustomer && matches ? (
        <>
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
        </>
      ) : null}
      {!needsCustomer && candidates
        ? candidates.map((candidate) => (
            <Choice
              key={candidate.user_id}
              selected={consultant === candidate.user_id}
              title={`${candidate.full_name}${candidate.recommended ? '  ★ Recommended' : ''}`}
              detail={`${candidate.open_leads} open · ${candidate.hot_leads} hot`}
              onPress={() => setConsultant(candidate.user_id)}
            />
          ))
        : null}
      {!loading ? (
        <>
          <Text style={styles.label}>{needsCustomer ? 'Reason' : 'Note for Sales'}</Text>
          <TextInput
            value={needsCustomer ? reason : note}
            onChangeText={needsCustomer ? setReason : setNote}
            style={styles.input}
            maxLength={500}
            placeholder={needsCustomer ? 'Why this customer' : 'Note for Sales'}
            placeholderTextColor={colors.faint}
          />
        </>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  label: {
    color: colors.muted,
    fontSize: font.label,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  muted: { color: colors.muted, fontSize: font.small },
  more: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start' },
  moreText: { color: colors.primary, fontSize: font.row, fontWeight: '600' },
  error: { color: colors.danger, fontSize: font.small, fontWeight: '700' },
  input: {
    height: 50,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    paddingHorizontal: space.md,
    color: colors.text,
    fontSize: font.body,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  optionSelected: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  optionTitle: { color: colors.text, fontSize: font.body, fontWeight: '600' },
  optionDetail: { color: colors.muted, fontSize: font.label, fontWeight: '600', marginTop: 2 },
  dot: { width: 12, height: 12, borderRadius: 6 },
});
