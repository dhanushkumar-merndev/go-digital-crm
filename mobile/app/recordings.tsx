import * as DocumentPicker from 'expo-document-picker';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Screen } from '@/components/screen';
import { Badge, EmptyState, PrimaryButton } from '@/components/ui/basics';
import { Sheet } from '@/components/ui/sheet';
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
import { colors, font } from '@/theme';

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
  PENDING: { color: colors.primary, background: colors.infoSoft },
  NEEDS_NUMBER: { color: colors.warningStrong, background: colors.warningSoft },
  SYNCED: { color: colors.successStrong, background: colors.successSoft },
  FAILED: { color: colors.dangerStrong, background: colors.dangerSoft },
  UNSUPPORTED: { color: colors.muted, background: colors.subtle },
  OLDER: { color: colors.muted, background: colors.subtle },
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
      subtitle={lastSync ? `Last synced ${dateTime(lastSync)}` : undefined}
      back
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
              <PrimaryButton
                label={folder ? 'Change folder' : 'Choose folder'}
                icon="folder-open-outline"
                variant="secondary"
                style={styles.grow}
                onPress={() => void chooseFolder()}
              />
              {folder ? (
                <PrimaryButton
                  label="Sync now"
                  icon="sync"
                  busy={syncing}
                  style={styles.grow}
                  onPress={() => void sync(userId)}
                />
              ) : null}
            </View>
          </>
        ) : (
          <Text style={styles.body}>
            Folder sync is available on Android. Upload recordings below instead.
          </Text>
        )}
        <PrimaryButton
          label="Upload recordings"
          icon="cloud-upload-outline"
          variant="secondary"
          disabled={syncing}
          onPress={() => void pickFiles()}
        />
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
                <Badge
                  label={statusLabels[row.status]}
                  tone={{ fg: tone.color, bg: tone.background }}
                />
              </Pressable>
            );
          })
        ) : (
          <EmptyState
            icon="mic-outline"
            title={folder ? 'No new call recordings yet' : 'No recordings yet'}
            detail={folder ? undefined : 'Choose a folder or upload a recording.'}
          />
        )}
      </View>

      {editing ? (
        <DetailsSheet
          key={editing.uri}
          row={editing}
          onClose={() => setEditing(null)}
          onSave={(input) => {
            if (!userId) return;
            if (editing.status === 'FAILED' && !input.phone) retryRecording(userId, editing.uri);
            else setRecordingDetails(userId, editing.uri, input);
            setEditing(null);
            void sync(userId);
          }}
        />
      ) : null}
    </Screen>
  );
}

function DetailsSheet({
  row,
  onClose,
  onSave,
}: {
  row: RecordingRow;
  onClose: () => void;
  onSave: (input: { phone: string; direction: 'INBOUND' | 'OUTBOUND' }) => void;
}) {
  // Mounted per recording, so the draft always starts from that recording.
  const [phone, setPhone] = useState(row.phone ?? '');
  const [direction, setDirection] = useState<'INBOUND' | 'OUTBOUND'>(row.direction ?? 'OUTBOUND');
  const [error, setError] = useState<string>();
  const save = () => {
    if (phone.replace(/\D/g, '').length < 8) {
      setError('Enter the customer’s phone number.');
      return;
    }
    try {
      onSave({ phone, direction });
    } catch {
      setError('Enter a valid mobile number.');
    }
  };
  return (
    <Sheet
      title={row.status === 'FAILED' ? 'Retry recording' : 'Which number was this call?'}
      subtitle={`${row.contactName ? `${row.contactName} · ` : ''}${row.name}`}
      onClose={onClose}
      footer={<PrimaryButton label="Sync" icon="sync" style={styles.grow} onPress={save} />}
    >
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
    </Sheet>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 16,
    padding: 15,
    gap: 10,
  },
  cardTitle: { color: colors.navy, fontSize: font.heading, fontWeight: '600' },
  body: { color: colors.muted, fontSize: font.label, lineHeight: 18 },
  row: { flexDirection: 'row', gap: 10 },
  grow: { flex: 1 },
  summary: { color: colors.text, fontSize: font.label, fontWeight: '700' },
  error: { color: colors.danger, fontSize: font.label, lineHeight: 17 },
  notice: {
    borderColor: colors.warningBorder,
    borderWidth: 1,
    backgroundColor: colors.warningSoft,
    borderRadius: 14,
    padding: 14,
  },
  noticeTitle: { color: colors.warningDeep, fontWeight: '600' },
  noticeText: { color: colors.warningStrong, fontSize: font.label, marginTop: 3 },
  hint: { color: colors.muted, fontSize: font.label, lineHeight: 17 },
  recording: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
  },
  recordingMain: { flex: 1 },
  recordingTitle: { color: colors.text, fontWeight: '600', fontSize: font.row },
  recordingMeta: { color: colors.muted, fontSize: font.caption, marginTop: 2 },
  recordingError: { color: colors.danger, fontSize: font.caption, marginTop: 2 },
  inputLabel: { color: colors.text, fontSize: font.label, fontWeight: '600', marginTop: 4 },
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
  choiceActive: { borderColor: colors.primary, backgroundColor: colors.infoSoft },
  choiceText: { color: colors.text, fontWeight: '700', fontSize: font.label },
  choiceTextActive: { color: colors.primary },
});
