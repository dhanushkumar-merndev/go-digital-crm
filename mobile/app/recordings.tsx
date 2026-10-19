import * as DocumentPicker from 'expo-document-picker';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Screen } from '@/components/screen';
import {
  addPickedRecordings,
  chooseRecordingFolder,
  getLastRecordingSync,
  getRecordingFolder,
  includeOlderRecordings,
  initializeRecordingLedger,
  listRecordings,
  onRecordingSyncFinished,
  recordingCounts,
  recordingFolderSupported,
  retryRecording,
  setRecordingDetails,
  syncRecordings,
  type RecordingFolder,
  type RecordingRow,
  type RecordingStatus,
  type SyncSummary,
} from '@/lib/recording-sync';
import { supabase } from '@/lib/supabase';
import { colors } from '@/theme';

function dateTime(value: number | null) {
  if (!value) return 'Time unknown';
  return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}

const statusLabels: Record<RecordingStatus, string> = {
  PENDING: 'Waiting',
  NEEDS_NUMBER: 'Needs number',
  SYNCED: 'Synced',
  FAILED: 'Failed',
  UNSUPPORTED: 'Format not supported',
  OLDER: 'Older',
};

const statusTones: Record<RecordingStatus, { color: string; background: string }> = {
  PENDING: { color: '#1d4ed8', background: '#eff6ff' },
  NEEDS_NUMBER: { color: '#b45309', background: '#fffbeb' },
  SYNCED: { color: '#047857', background: '#ecfdf5' },
  FAILED: { color: '#b91c1c', background: '#fef2f2' },
  UNSUPPORTED: { color: colors.muted, background: '#f1f5f9' },
  OLDER: { color: colors.muted, background: '#f1f5f9' },
};

const errorLabels: Record<string, string> = {
  RECORDED_CALL_PHONE_INVALID: 'The number is not valid.',
  RECORDING_FILE_MISSING: 'The file is no longer on the phone.',
  RECORDING_SIZE_INVALID: 'The file is empty or larger than 100 MB.',
  RECORDING_TYPE_NOT_ALLOWED: 'This audio format cannot be uploaded.',
  PERMISSION_DENIED: 'Your role cannot log calls.',
  CALL_BRANCH_REQUIRED: 'You are not in a team or branch yet.',
  CALL_START_TIME_OUT_OF_RANGE: 'The call is older than a year.',
};

export default function Recordings() {
  const [userId, setUserId] = useState<string | null>(null);
  const [folder, setFolder] = useState<RecordingFolder | null>(null);
  const [rows, setRows] = useState<RecordingRow[]>([]);
  const [counts, setCounts] = useState<Partial<Record<RecordingStatus, number>>>({});
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [summary, setSummary] = useState<SyncSummary | null>(null);
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<RecordingRow | null>(null);

  const refresh = useCallback(async (id: string | null) => {
    if (!id) return;
    setRows(listRecordings(id));
    setCounts(recordingCounts(id));
    setFolder(await getRecordingFolder());
    setLastSync(await getLastRecordingSync());
  }, []);

  const sync = useCallback(
    async (id: string | null) => {
      if (!id) return;
      setSyncing(true);
      setError(undefined);
      try {
        setSummary(await syncRecordings({ userId: id }));
      } catch {
        setError('Sync could not run. Check your connection and try again.');
      } finally {
        setSyncing(false);
        await refresh(id);
      }
    },
    [refresh],
  );

  useFocusEffect(
    useCallback(() => {
      let active = true;
      void (async () => {
        initializeRecordingLedger();
        const { data } = await supabase.auth.getSession();
        const id = data.session?.user.id ?? null;
        if (!active) return;
        setUserId(id);
        await refresh(id);
      })();
      const unsubscribe = onRecordingSyncFinished(() => {
        void supabase.auth.getSession().then(({ data }) => {
          if (active) void refresh(data.session?.user.id ?? null);
        });
      });
      return () => {
        active = false;
        unsubscribe();
      };
    }, [refresh]),
  );

  const chooseFolder = async () => {
    setError(undefined);
    try {
      const chosen = await chooseRecordingFolder();
      setFolder(chosen);
      if (chosen) await sync(userId);
    } catch {
      setError('The folder could not be opened. Choose the folder your call recorder saves to.');
    }
  };

  const pickFiles = async () => {
    if (!userId) return;
    const selection = await DocumentPicker.getDocumentAsync({
      type: ['audio/*'],
      copyToCacheDirectory: true,
      multiple: true,
    });
    if (selection.canceled) return;
    addPickedRecordings(userId, selection.assets);
    await sync(userId);
  };

  const open = (row: RecordingRow) => {
    if (row.status === 'SYNCED' && row.callId)
      router.push({ pathname: '/call/[id]', params: { id: row.callId } });
    else if (row.status === 'NEEDS_NUMBER' || row.status === 'FAILED') setEditing(row);
  };

  const older = counts.OLDER ?? 0;
  const waiting = (counts.PENDING ?? 0) + (counts.FAILED ?? 0);

  return (
    <Screen
      title="Call recordings"
      subtitle={lastSync ? `Last synced ${dateTime(lastSync)}` : 'Recordings from your phone'}
      action={
        <Pressable onPress={() => router.back()}>
          <Text style={styles.back}>Back</Text>
        </Pressable>
      }
    >
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Recorder folder</Text>
        {recordingFolderSupported() ? (
          <>
            <Text style={styles.body}>
              {folder
                ? `Watching “${folder.name}”. New call recordings are filed on the lead with that number, or kept as a new number you can turn into a lead.`
                : 'Choose the folder your phone saves call recordings to (often Recordings › Call). The app only reads that folder.'}
            </Text>
            <View style={styles.row}>
              <Pressable style={styles.secondary} onPress={() => void chooseFolder()}>
                <Text style={styles.secondaryText}>
                  {folder ? 'Change folder' : 'Choose folder'}
                </Text>
              </Pressable>
              {folder ? (
                <Pressable
                  style={styles.primary}
                  onPress={() => void sync(userId)}
                  disabled={syncing}
                >
                  <Text style={styles.primaryText}>{syncing ? 'Syncing…' : 'Sync now'}</Text>
                </Pressable>
              ) : null}
            </View>
          </>
        ) : (
          <Text style={styles.body}>
            Folder sync is available on Android. Upload recordings below instead.
          </Text>
        )}
        <Pressable style={styles.secondary} onPress={() => void pickFiles()} disabled={syncing}>
          <Text style={styles.secondaryText}>Upload recordings</Text>
        </Pressable>
        {syncing ? <ActivityIndicator color={colors.primary} /> : null}
        {summary && !syncing ? (
          <Text style={styles.summary}>
            {summary.synced} synced
            {summary.failed ? ` · ${summary.failed} failed` : ''}
            {summary.remaining ? ` · ${summary.remaining} still waiting` : ''}
          </Text>
        ) : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>

      {older ? (
        <Pressable
          style={styles.notice}
          onPress={() => {
            if (!userId) return;
            includeOlderRecordings(userId);
            void sync(userId);
          }}
        >
          <Text style={styles.noticeTitle}>
            {older} older recording{older === 1 ? '' : 's'} in this folder
          </Text>
          <Text style={styles.noticeText}>
            Recorded before you chose the folder. Tap to sync them too.
          </Text>
        </Pressable>
      ) : null}
      {waiting > 5 ? (
        <Text style={styles.hint}>
          {waiting} recordings are waiting. Each sync sends five; keep tapping Sync now or leave the
          app open.
        </Text>
      ) : null}

      <View style={styles.card}>
        {rows.length ? (
          rows.map((row) => {
            const tone = statusTones[row.status];
            return (
              <Pressable key={row.uri} style={styles.recording} onPress={() => open(row)}>
                <View style={styles.recordingMain}>
                  <Text style={styles.recordingTitle} numberOfLines={1}>
                    {row.status === 'SYNCED'
                      ? (row.customerName ?? row.phone ?? 'New number')
                      : (row.phone ?? row.contactName ?? row.name)}
                  </Text>
                  <Text style={styles.recordingMeta} numberOfLines={1}>
                    {dateTime(row.startedAt ?? row.modifiedAt)}
                    {row.status === 'SYNCED'
                      ? row.matched
                        ? ' · on lead'
                        : ' · no lead yet — tap to create'
                      : ''}
                  </Text>
                  {row.status === 'FAILED' && row.error ? (
                    <Text style={styles.recordingError} numberOfLines={2}>
                      {errorLabels[row.error] ?? row.error}
                    </Text>
                  ) : null}
                </View>
                <View style={[styles.badge, { backgroundColor: tone.background }]}>
                  <Text style={[styles.badgeText, { color: tone.color }]}>
                    {statusLabels[row.status]}
                  </Text>
                </View>
              </Pressable>
            );
          })
        ) : (
          <Text style={styles.empty}>
            {folder ? 'No new call recordings yet.' : 'Choose a folder or upload a recording.'}
          </Text>
        )}
      </View>

      <DetailsModal
        row={editing}
        onClose={() => setEditing(null)}
        onSave={(input) => {
          if (!userId || !editing) return;
          if (editing.status === 'FAILED' && !input.phone) retryRecording(userId, editing.uri);
          else setRecordingDetails(userId, editing.uri, input);
          setEditing(null);
          void sync(userId);
        }}
      />
    </Screen>
  );
}

function DetailsModal({
  row,
  onClose,
  onSave,
}: {
  row: RecordingRow | null;
  onClose: () => void;
  onSave: (input: { phone: string; direction: 'INBOUND' | 'OUTBOUND' }) => void;
}) {
  const [phone, setPhone] = useState('');
  const [direction, setDirection] = useState<'INBOUND' | 'OUTBOUND'>('OUTBOUND');
  const [error, setError] = useState<string>();
  const [shownFor, setShownFor] = useState<string | null>(null);
  if (row && shownFor !== row.uri) {
    setShownFor(row.uri);
    setPhone(row.phone ?? '');
    setDirection(row.direction ?? 'OUTBOUND');
    setError(undefined);
  }
  // A closed sheet forgets its draft, so reopening starts from the recording.
  if (!row && shownFor !== null) setShownFor(null);
  return (
    <Modal visible={Boolean(row)} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior="padding" style={styles.modalBackdrop}>
        <View style={styles.modal}>
          <Text style={styles.modalTitle}>
            {row?.status === 'FAILED' ? 'Retry recording' : 'Which number was this call?'}
          </Text>
          <Text style={styles.modalText} numberOfLines={2}>
            {row?.contactName ? `${row.contactName} · ` : ''}
            {row?.name}
          </Text>
          <Text style={styles.inputLabel}>Customer phone</Text>
          <TextInput
            value={phone}
            onChangeText={setPhone}
            style={styles.input}
            keyboardType="phone-pad"
            placeholder="98765 43210"
          />
          <View style={styles.row}>
            {(['OUTBOUND', 'INBOUND'] as const).map((value) => (
              <Pressable
                key={value}
                style={[styles.choice, direction === value && styles.choiceActive]}
                onPress={() => setDirection(value)}
              >
                <Text style={[styles.choiceText, direction === value && styles.choiceTextActive]}>
                  {value === 'OUTBOUND' ? 'I called them' : 'They called me'}
                </Text>
              </Pressable>
            ))}
          </View>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <View style={styles.modalActions}>
            <Pressable style={styles.modalCancel} onPress={onClose}>
              <Text style={styles.modalCancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={styles.modalSave}
              onPress={() => {
                if (phone.replace(/\D/g, '').length < 8) {
                  setError('Enter the customer’s phone number.');
                  return;
                }
                try {
                  onSave({ phone, direction });
                } catch {
                  setError('Enter a valid mobile number.');
                }
              }}
            >
              <Text style={styles.modalSaveText}>Sync</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  back: { color: colors.primary, fontWeight: '700' },
  card: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 16,
    padding: 15,
    gap: 10,
  },
  cardTitle: { color: colors.navy, fontSize: 16, fontWeight: '800' },
  body: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  row: { flexDirection: 'row', gap: 10 },
  primary: {
    flex: 1,
    backgroundColor: colors.primary,
    alignItems: 'center',
    padding: 12,
    borderRadius: 11,
  },
  primaryText: { color: 'white', fontWeight: '800' },
  secondary: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.primary,
    alignItems: 'center',
    padding: 12,
    borderRadius: 11,
  },
  secondaryText: { color: colors.primary, fontWeight: '800' },
  summary: { color: colors.text, fontSize: 12, fontWeight: '700' },
  error: { color: colors.danger, fontSize: 12, lineHeight: 17 },
  notice: {
    borderColor: '#fde68a',
    borderWidth: 1,
    backgroundColor: '#fffbeb',
    borderRadius: 14,
    padding: 14,
  },
  noticeTitle: { color: '#92400e', fontWeight: '800' },
  noticeText: { color: '#b45309', fontSize: 12, marginTop: 3 },
  hint: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  recording: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
  },
  recordingMain: { flex: 1 },
  recordingTitle: { color: colors.text, fontWeight: '800', fontSize: 14 },
  recordingMeta: { color: colors.muted, fontSize: 11, marginTop: 2 },
  recordingError: { color: colors.danger, fontSize: 11, marginTop: 2 },
  badge: { borderRadius: 999, paddingHorizontal: 9, paddingVertical: 4 },
  badgeText: { fontSize: 10, fontWeight: '800' },
  empty: { color: colors.muted, fontSize: 13, textAlign: 'center', padding: 12 },
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
  },
  choice: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 9,
    paddingVertical: 10,
    alignItems: 'center',
  },
  choiceActive: { borderColor: colors.primary, backgroundColor: '#eff6ff' },
  choiceText: { color: colors.text, fontWeight: '700', fontSize: 12 },
  choiceTextActive: { color: colors.primary },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 6 },
  modalCancel: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingVertical: 11,
    paddingHorizontal: 14,
  },
  modalCancelText: { color: colors.text, fontWeight: '800' },
  modalSave: {
    backgroundColor: colors.primary,
    borderRadius: 10,
    paddingVertical: 11,
    paddingHorizontal: 14,
  },
  modalSaveText: { color: 'white', fontWeight: '800' },
});
