import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react';
import { useFocusEffect } from 'expo-router';
import { AppState, StyleSheet, Text, View } from 'react-native';
import { Chip, PrimaryButton } from '@/components/ui/basics';
import { Icon, type IconName } from '@/components/ui/icon';
import { PressableScale } from '@/components/ui/pressable-scale';
import { Sheet } from '@/components/ui/sheet';
import { useToast } from '@/components/ui/toast';
import { WhenPicker } from '@/components/ui/when-picker';
import { openDialer, recordCallContact } from '@/lib/contact';
import { leadActionMessage } from '@/lib/lead-detail';
import { findRecorderFolder } from '@/lib/recording-sync';
import { completeFollowup, isVersionConflict, setLeadNextFollowup } from '@/lib/work-actions';
import { tick } from '@/motion/haptics';
import { RecorderFolderOfferSheet, type RecorderFolderOffer } from './recorder-folder-offer';
import { colors, font, radius, space } from '@/theme';

export const followupReasons = [
  'Customer callback',
  'Quotation discussion',
  'Test drive confirmation',
  'Price negotiation',
  'General follow-up',
] as const;

type Outcome = 'CONNECTED' | 'NO_ANSWER' | 'BUSY' | 'CALL_BACK' | 'WRONG_NUMBER';
const outcomes: Array<{ value: Outcome; label: string; icon: IconName; tone: string }> = [
  { value: 'CONNECTED', label: 'Connected', icon: 'checkmark-circle', tone: colors.success },
  { value: 'NO_ANSWER', label: 'No answer', icon: 'call-outline', tone: colors.warning },
  { value: 'BUSY', label: 'Busy', icon: 'time-outline', tone: colors.warning },
  { value: 'CALL_BACK', label: 'Call back', icon: 'return-up-back', tone: colors.primary },
  { value: 'WRONG_NUMBER', label: 'Wrong number', icon: 'close-circle', tone: colors.danger },
];

export type CallTarget = {
  leadId: string | null;
  phone: string;
  name: string;
  // Set when the call starts from a follow-up row, so the result can close it.
  followup?: { id: string; version: number };
};

// A call logs from anywhere, so every screen in view reloads. An edit made on
// one screen (Done, Later, a sheet) already updated that screen itself.
type Change = 'call' | 'edit';
type CallFlow = {
  call: (target: CallTarget) => void;
  changed: (kind: Change) => void;
  onChanged: (listener: (kind: Change) => void) => () => void;
};
const CallFlowContext = createContext<CallFlow>({
  call: () => undefined,
  changed: () => undefined,
  onChanged: () => () => {},
});

export function useCallFlow() {
  return useContext(CallFlowContext);
}

// Tabs stay mounted, so reloading every listener on each change refetched
// Today, Leads, Follow-ups and Tasks at once. Screens out of view only go
// stale and reload the next time they are opened.
export function useWorkRefresh(reload: () => void) {
  const { onChanged } = useCallFlow();
  const focused = useRef(false);
  const stale = useRef(false);
  const latest = useRef(reload);
  latest.current = reload;
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      if (stale.current) {
        stale.current = false;
        latest.current();
      }
      return () => {
        focused.current = false;
      };
    }, []),
  );
  useEffect(
    () =>
      onChanged((kind) => {
        if (!focused.current) stale.current = true;
        else if (kind === 'call') latest.current();
      }),
    [onChanged],
  );
}

function inTwoHours() {
  const next = new Date(Date.now() + 2 * 60 * 60 * 1000);
  next.setMinutes(next.getMinutes() < 30 ? 30 : 60, 0, 0);
  return next;
}

function tomorrowAtTen() {
  const next = new Date();
  next.setDate(next.getDate() + 1);
  next.setHours(10, 0, 0, 0);
  return next;
}

// Call from anywhere: open the dialer, record the contact, and when the user
// comes back to the app ask how it went so the next step is one tap away.
export function CallFlowProvider({ children }: PropsWithChildren) {
  const toast = useToast();
  const pending = useRef<{ target: CallTarget; leftAt: number | null; startedAt: number }>(
    undefined,
  );
  const listeners = useRef(new Set<(kind: Change) => void>());
  const [prompt, setPrompt] = useState<CallTarget>();
  const [folderOffer, setFolderOffer] = useState<RecorderFolderOffer>();
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      const current = pending.current;
      if (!current) return;
      if (state !== 'active') {
        current.leftAt ??= Date.now();
        return;
      }
      const talked = Boolean(current.leftAt && Date.now() - current.leftAt > 2500);
      if (talked && current.target.leadId) {
        setPrompt(current.target);
      }
      // First call with no recorder folder: find where the dialer saved it.
      // The recorder finishes writing a moment after the call ends.
      if (talked) {
        const { startedAt, target } = current;
        setTimeout(() => {
          findRecorderFolder(startedAt, target.phone)
            .then((offer) => offer && setFolderOffer(offer))
            .catch(() => undefined);
        }, 4000);
      }
      pending.current = undefined;
    });
    return () => subscription.remove();
  }, []);
  const changed = useCallback(
    (kind: Change) => listeners.current.forEach((listener) => listener(kind)),
    [],
  );
  const notify = useCallback(() => changed('call'), [changed]);
  const call = useCallback(
    (target: CallTarget) => {
      tick();
      pending.current = { target, leftAt: null, startedAt: Date.now() };
      void openDialer(target.phone);
      if (target.leadId) {
        recordCallContact(target.leadId)
          .then(notify)
          .catch((error) =>
            toast({
              tone: 'error',
              message: leadActionMessage(error, 'The call could not be recorded on the lead.'),
            }),
          );
      }
    },
    [notify, toast],
  );
  const onChanged = useCallback((listener: (kind: Change) => void) => {
    listeners.current.add(listener);
    return () => listeners.current.delete(listener);
  }, []);
  const value = useMemo(() => ({ call, changed, onChanged }), [call, changed, onChanged]);
  return (
    <CallFlowContext.Provider value={value}>
      {children}
      {prompt ? (
        <OutcomeSheet
          target={prompt}
          onClose={() => setPrompt(undefined)}
          onSaved={(message) => {
            setPrompt(undefined);
            toast({ message });
            notify();
          }}
        />
      ) : null}
      {folderOffer && !prompt ? (
        <RecorderFolderOfferSheet offer={folderOffer} onClose={() => setFolderOffer(undefined)} />
      ) : null}
    </CallFlowContext.Provider>
  );
}

function OutcomeSheet({
  target,
  onClose,
  onSaved,
}: {
  target: CallTarget;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [outcome, setOutcome] = useState<Outcome>();
  const [dueAt, setDueAt] = useState(tomorrowAtTen);
  const [reason, setReason] = useState<string>(followupReasons[0]);
  const [closeOnly, setCloseOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const choose = (value: Outcome) => {
    tick();
    setOutcome(value);
    setError(undefined);
    setCloseOnly(value === 'WRONG_NUMBER');
    if (value === 'NO_ANSWER' || value === 'BUSY') {
      setDueAt(inTwoHours());
      setReason('Customer callback');
    } else if (value === 'CALL_BACK') {
      setDueAt(tomorrowAtTen());
      setReason('Customer callback');
    }
  };
  const save = async () => {
    if (!outcome || !target.leadId) return;
    setBusy(true);
    setError(undefined);
    try {
      if (closeOnly) {
        if (target.followup)
          await completeFollowup({ ...target.followup, note: outcomeNote(outcome) });
        onSaved(target.followup ? 'Follow-up closed.' : 'Call noted.');
        return;
      }
      await setLeadNextFollowup({ leadId: target.leadId, reason, dueAt });
      onSaved('Next follow-up set.');
    } catch (saveError) {
      setError(
        isVersionConflict(saveError)
          ? 'This follow-up changed elsewhere. Close and refresh.'
          : leadActionMessage(saveError, 'Could not save. Check your connection and try again.'),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      title="How did the call go?"
      subtitle={target.name}
      onClose={onClose}
      footer={
        <>
          <PrimaryButton label="Skip" variant="secondary" onPress={onClose} style={styles.grow} />
          <PrimaryButton
            label={closeOnly ? 'Save' : 'Save next step'}
            icon="checkmark"
            onPress={() => void save()}
            busy={busy}
            disabled={!outcome}
            style={styles.grow}
          />
        </>
      }
    >
      <View style={styles.outcomes}>
        {outcomes.map((item) => {
          const selected = outcome === item.value;
          return (
            <PressableScale
              key={item.value}
              onPress={() => choose(item.value)}
              style={[
                styles.outcome,
                selected && { borderColor: item.tone, backgroundColor: `${item.tone}12` },
              ]}
            >
              <Icon name={item.icon} size={22} color={item.tone} />
              <Text style={styles.outcomeText}>{item.label}</Text>
            </PressableScale>
          );
        })}
      </View>
      {outcome === 'CONNECTED' && target.followup ? (
        <View style={styles.toggle}>
          <Chip
            label="Set next follow-up"
            selected={!closeOnly}
            onPress={() => setCloseOnly(false)}
          />
          <Chip label="All done" selected={closeOnly} onPress={() => setCloseOnly(true)} />
        </View>
      ) : null}
      {outcome && !closeOnly ? (
        <>
          <Text style={styles.label}>Reason</Text>
          <View style={styles.toggle}>
            {followupReasons.map((item) => (
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
        </>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </Sheet>
  );
}

function outcomeNote(outcome: Outcome) {
  return outcome === 'WRONG_NUMBER' ? 'Wrong number.' : 'Completed after call.';
}

const styles = StyleSheet.create({
  grow: { flex: 1 },
  outcomes: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  outcome: {
    width: '31.5%',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 14,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  outcomeText: { color: colors.text, fontSize: font.label, fontWeight: '600' },
  toggle: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  label: {
    color: colors.muted,
    fontSize: font.label,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  error: { color: colors.danger, fontSize: font.small, fontWeight: '700' },
});
