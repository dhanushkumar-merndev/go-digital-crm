import { router, useLocalSearchParams } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import { useCallback, useEffect, useMemo, useState } from 'react';
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
  createMobileCallFollowup,
  fetchMobileCallDetail,
  getMobileRecordingDownload,
  uploadMobileCallRecording,
  type MobileCallDetail,
} from '@/lib/calls';
import { colors } from '@/theme';

function duration(value: number | null) {
  if (value === null) return 'Duration unavailable';
  return `${Math.floor(value / 60)}m ${(value % 60).toString().padStart(2, '0')}s`;
}

function dateTime(value: string) {
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

function initials(name: string | null) {
  return (name ?? 'Customer')
    .split(' ')
    .filter(Boolean)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

export default function CallSummary() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [call, setCall] = useState<MobileCallDetail>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [recordingError, setRecordingError] = useState<string>();
  const [recordingUploaded, setRecordingUploaded] = useState(false);
  const [followupOpen, setFollowupOpen] = useState(false);
  const [reason, setReason] = useState('Follow up after call');
  const [dueAt, setDueAt] = useState(localDateInput);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const readyRecording = useMemo(
    () => call?.recordings.find((recording) => recording.object_file_id) ?? null,
    [call],
  );
  const canScheduleFollowup = Boolean(call?.lead_id || call?.customer_id);
  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(false);
    try {
      setCall(await fetchMobileCallDetail(id));
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);
  const callCustomer = () => {
    if (call?.phone) void Linking.openURL(`tel:${call.phone.replace(/[^+\d]/g, '')}`);
  };
  const downloadRecording = async () => {
    if (!readyRecording?.object_file_id) return;
    setDownloading(true);
    try {
      await Linking.openURL(await getMobileRecordingDownload(readyRecording.object_file_id));
    } finally {
      setDownloading(false);
    }
  };
  const uploadRecording = async () => {
    if (!call) return;
    setUploading(true);
    setRecordingError(undefined);
    setRecordingUploaded(false);
    try {
      const selection = await DocumentPicker.getDocumentAsync({
        type: [
          'audio/mpeg',
          'audio/mpeg3',
          'audio/x-mpeg',
          'audio/mp4',
          'audio/m4a',
          'audio/x-m4a',
          'audio/wav',
          'audio/x-wav',
          'audio/wave',
          'audio/vnd.wave',
          'audio/ogg',
          'audio/webm',
        ],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (selection.canceled) return;
      const asset = selection.assets[0];
      if (!asset) throw new Error('RECORDING_SELECTION_EMPTY');
      await uploadMobileCallRecording({ call, asset, requestId: requestId() });
      setRecordingUploaded(true);
      await load();
    } catch (uploadError) {
      const code = uploadError instanceof Error ? uploadError.message : '';
      setRecordingError(
        code === 'RECORDING_SIZE_INVALID'
          ? 'Choose a recording between 1 byte and 100 MB.'
          : code === 'RECORDING_TYPE_NOT_ALLOWED'
            ? 'Choose an MP3, MP4, M4A, WAV, OGG, or WebM audio file.'
            : 'Recording upload failed. Check your connection and try again.',
      );
    } finally {
      setUploading(false);
    }
  };
  const scheduleFollowup = async () => {
    if (!call) return;
    const date = new Date(dueAt.replace(' ', 'T'));
    if (reason.trim().length < 3 || Number.isNaN(date.getTime())) {
      setFormError('Enter a reason and a valid local date/time.');
      return;
    }
    setSaving(true);
    setFormError(undefined);
    try {
      await createMobileCallFollowup({
        call,
        reason: reason.trim(),
        dueAt: date.toISOString(),
        requestId: requestId(),
      });
      setSaved(true);
      setFollowupOpen(false);
    } catch {
      setFormError('Follow-up could not be scheduled. Check access and try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen
      title="Call summary"
      subtitle={call ? dateTime(call.started_at) : 'Authorized call record'}
      action={
        <Pressable onPress={() => router.back()}>
          <Text style={styles.back}>Back</Text>
        </Pressable>
      }
    >
      {loading ? (
        <View style={styles.loading}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : null}
      {error ? (
        <Pressable style={styles.error} onPress={() => void load()}>
          <Text style={styles.errorTitle}>Call detail is unavailable</Text>
          <Text style={styles.errorText}>
            It may be outside your current permission or data scope. Tap to retry.
          </Text>
        </Pressable>
      ) : null}
      {call ? (
        <>
          <View style={styles.card}>
            <View style={styles.customerRow}>
              <View style={styles.customerAvatar}>
                <Text style={styles.customerAvatarText}>{initials(call.customer_name)}</Text>
              </View>
              <View style={styles.customerMain}>
                <Text style={styles.customerName}>{call.customer_name ?? 'Restricted party'}</Text>
                {call.phone ? (
                  <Pressable onPress={callCustomer}>
                    <Text style={styles.phone}>{call.phone}</Text>
                  </Pressable>
                ) : (
                  <Text style={styles.restricted}>Phone is not available in your scope</Text>
                )}
                <Text style={styles.context}>
                  {call.branch_name}
                  {call.team_name ? ` · ${call.team_name}` : ''}
                </Text>
              </View>
            </View>
            <View style={styles.divider} />
            <Text style={styles.source}>
              {call.direction} ·{' '}
              {call.call_source === 'PROVIDER'
                ? (call.provider_name ?? 'Provider call')
                : 'Manual call'}
            </Text>
          </View>

          <View style={styles.card}>
            <View style={styles.factRow}>
              <Fact
                label="Status"
                value={(call.outcome ?? call.status).replaceAll('_', ' ')}
                tone={colors.success}
              />
              <Fact label="Duration" value={duration(call.duration_seconds)} />
              <Fact label="Call time" value={dateTime(call.started_at)} />
            </View>
            <View style={styles.recording}>
              <View style={styles.recordingMain}>
                <Text style={styles.recordingTitle}>Recording</Text>
                <Text style={styles.recordingText}>
                  {readyRecording
                    ? 'Private recording available'
                    : 'No recording attached to this call'}
                </Text>
              </View>
              {readyRecording ? (
                <Pressable
                  style={styles.download}
                  onPress={() => void downloadRecording()}
                  disabled={downloading}
                >
                  <Text style={styles.downloadText}>{downloading ? 'Opening…' : 'Open'}</Text>
                </Pressable>
              ) : call.call_source === 'PERSONAL_MANUAL' ? (
                <Pressable
                  style={styles.download}
                  onPress={() => void uploadRecording()}
                  disabled={uploading}
                >
                  <Text style={styles.downloadText}>{uploading ? 'Uploading…' : 'Upload'}</Text>
                </Pressable>
              ) : null}
            </View>
            {recordingError ? <Text style={styles.formError}>{recordingError}</Text> : null}
            {recordingUploaded ? (
              <Text style={styles.uploadSuccess}>Recording uploaded securely.</Text>
            ) : null}
          </View>

          <InsightCard
            title="AI call summary"
            tone="#7c3aed"
            text={call.ai_summary?.summary ?? 'AI summary is not available for this call.'}
          />
          <SpeakerTranscriptCard transcript={call.transcript} />
          {call.notes ? (
            <InsightCard title="Call notes" tone={colors.navy} text={call.notes} />
          ) : null}

          <View style={styles.card}>
            <Text style={styles.nextTitle}>Next action</Text>
            <Text style={styles.nextText}>
              Choose the next step based on the completed call. No AI recommendation is shown unless
              one is verified by the workflow.
            </Text>
            {saved ? <Text style={styles.success}>Follow-up scheduled successfully.</Text> : null}
            {canScheduleFollowup ? (
              <Pressable style={styles.primary} onPress={() => setFollowupOpen(true)}>
                <Text style={styles.primaryText}>Schedule follow-up</Text>
              </Pressable>
            ) : (
              <Text style={styles.restricted}>
                This call is not linked to a lead or customer, so a follow-up cannot be scheduled
                from it.
              </Text>
            )}
          </View>
          {call.phone ? (
            <Pressable style={styles.secondary} onPress={callCustomer}>
              <Text style={styles.secondaryText}>Call customer</Text>
            </Pressable>
          ) : null}
          {call.lead_id ? (
            <Pressable
              style={styles.secondary}
              onPress={() =>
                router.push({ pathname: '/lead/[id]', params: { id: call.lead_id as string } })
              }
            >
              <Text style={styles.secondaryText}>Open linked lead</Text>
            </Pressable>
          ) : null}
        </>
      ) : null}
      <Modal
        visible={followupOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setFollowupOpen(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modal}>
            <Text style={styles.modalTitle}>Schedule follow-up</Text>
            <Text style={styles.modalText}>
              This is created through the audited CRM follow-up workflow and assigned to you.
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
              <Pressable
                style={styles.modalCancel}
                onPress={() => setFollowupOpen(false)}
                disabled={saving}
              >
                <Text style={styles.modalCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={styles.modalSave}
                onPress={() => void scheduleFollowup()}
                disabled={saving}
              >
                <Text style={styles.modalSaveText}>{saving ? 'Scheduling…' : 'Schedule'}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </Screen>
  );
}

function Fact({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <View style={styles.fact}>
      <Text style={[styles.factValue, tone ? { color: tone } : undefined]} numberOfLines={2}>
        {value}
      </Text>
      <Text style={styles.factLabel}>{label}</Text>
    </View>
  );
}

function InsightCard({
  title,
  text,
  tone,
  note,
}: {
  title: string;
  text: string;
  tone: string;
  note?: string;
}) {
  return (
    <View style={styles.card}>
      <Text style={[styles.insightTitle, { color: tone }]}>{title}</Text>
      <Text style={styles.insightText}>{text}</Text>
      {note ? <Text style={styles.insightNote}>{note}</Text> : null}
    </View>
  );
}

function SpeakerTranscriptCard({ transcript }: { transcript: MobileCallDetail['transcript'] }) {
  if (!transcript?.speaker_turns.length)
    return (
      <InsightCard
        title="Transcript"
        tone={colors.primary}
        text={transcript?.text ?? 'Transcript processing has not produced text yet.'}
        note={
          transcript?.truncated
            ? 'Transcript preview is truncated for mobile response safety.'
            : undefined
        }
      />
    );

  const channelSeparated = /STEREO|CHANNEL/i.test(transcript.speaker_separation_method ?? '');
  return (
    <View style={styles.card}>
      <Text style={[styles.insightTitle, { color: colors.primary }]}>Transcript</Text>
      <View style={styles.speakerTurns}>
        {transcript.speaker_turns.map((turn, index) => {
          const label =
            turn.speaker === 'AGENT'
              ? 'Agent'
              : turn.speaker === 'CUSTOMER'
                ? 'Customer'
                : 'Unclear';
          return (
            <View
              key={`${index}-${turn.speaker}`}
              style={[
                styles.speakerBubble,
                turn.speaker === 'AGENT'
                  ? styles.agentBubble
                  : turn.speaker === 'CUSTOMER'
                    ? styles.customerBubble
                    : styles.unclearBubble,
              ]}
            >
              <Text
                style={[
                  styles.speakerLabel,
                  turn.speaker === 'AGENT'
                    ? styles.agentLabel
                    : turn.speaker === 'CUSTOMER'
                      ? styles.customerLabel
                      : styles.unclearLabel,
                ]}
              >
                {label}
              </Text>
              <Text style={styles.speakerText}>{turn.text}</Text>
            </View>
          );
        })}
      </View>
      {transcript.speaker_separation_method ? (
        <Text style={styles.insightNote}>
          {channelSeparated
            ? 'Speaker labels are based on separated call channels.'
            : 'Speaker labels were inferred by AI and may be imperfect. Unclear means the speaker could not be identified safely.'}
        </Text>
      ) : null}
      {transcript.truncated ? (
        <Text style={styles.insightNote}>
          Transcript preview is truncated for mobile response safety.
        </Text>
      ) : null}
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
    gap: 12,
  },
  customerRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  customerAvatar: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: '#fee2e2',
    alignItems: 'center',
    justifyContent: 'center',
  },
  customerAvatarText: { color: '#be123c', fontWeight: '800', fontSize: 19 },
  customerMain: { flex: 1 },
  customerName: { color: colors.navy, fontSize: 20, fontWeight: '800' },
  phone: { color: colors.success, fontWeight: '700', marginTop: 4 },
  context: { color: colors.muted, fontSize: 11, marginTop: 5 },
  restricted: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  divider: { height: 1, backgroundColor: colors.border },
  source: { color: colors.muted, fontSize: 11, fontWeight: '700' },
  factRow: { flexDirection: 'row', gap: 8 },
  fact: {
    flex: 1,
    minHeight: 64,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  factValue: { color: colors.text, fontSize: 12, fontWeight: '800', textAlign: 'center' },
  factLabel: { color: colors.muted, fontSize: 10, fontWeight: '700', marginTop: 6 },
  recording: {
    borderTopColor: colors.border,
    borderTopWidth: 1,
    paddingTop: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  recordingMain: { flex: 1 },
  recordingTitle: { color: colors.text, fontWeight: '800' },
  recordingText: { color: colors.muted, fontSize: 11, marginTop: 3 },
  download: {
    borderColor: colors.primary,
    borderWidth: 1,
    borderRadius: 9,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  downloadText: { color: colors.primary, fontSize: 12, fontWeight: '800' },
  insightTitle: { fontWeight: '800', fontSize: 17 },
  insightText: { color: colors.text, fontSize: 13, lineHeight: 20 },
  insightNote: { color: colors.warning, fontSize: 11, lineHeight: 16 },
  speakerTurns: { gap: 8 },
  speakerBubble: {
    maxWidth: '88%',
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 11,
    paddingVertical: 9,
  },
  agentBubble: { alignSelf: 'flex-start', borderColor: '#bfdbfe', backgroundColor: '#eff6ff' },
  customerBubble: {
    alignSelf: 'flex-end',
    borderColor: '#a7f3d0',
    backgroundColor: '#ecfdf5',
  },
  unclearBubble: { alignSelf: 'flex-start', borderColor: '#fde68a', backgroundColor: '#fffbeb' },
  speakerLabel: { fontSize: 10, fontWeight: '800', textTransform: 'uppercase' },
  agentLabel: { color: '#1d4ed8' },
  customerLabel: { color: '#047857' },
  unclearLabel: { color: '#92400e' },
  speakerText: { color: colors.text, fontSize: 13, lineHeight: 20, marginTop: 4 },
  nextTitle: { color: colors.navy, fontSize: 17, fontWeight: '800' },
  nextText: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  success: { color: colors.success, fontSize: 12, fontWeight: '800' },
  primary: { backgroundColor: colors.primary, alignItems: 'center', padding: 13, borderRadius: 11 },
  primaryText: { color: 'white', fontWeight: '800' },
  secondary: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.primary,
    alignItems: 'center',
    padding: 13,
    borderRadius: 11,
  },
  secondaryText: { color: colors.primary, fontWeight: '800' },
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
  uploadSuccess: { color: colors.success, fontSize: 12 },
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
