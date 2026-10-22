import { router, useLocalSearchParams } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { CallAiPanel } from '@/components/call-ai-panel';
import { Screen } from '@/components/screen';
import { ErrorState, initials, PrimaryButton, SkeletonList } from '@/components/ui/basics';
import { Sheet } from '@/components/ui/sheet';
import { WhenPicker } from '@/components/ui/when-picker';
import { fetchCallAiState, type CallAiState } from '@/lib/call-ai';
import {
  createMobileCallFollowup,
  fetchMobileCallDetail,
  getMobileRecordingDownload,
  uploadMobileCallRecording,
  type MobileCallDetail,
} from '@/lib/calls';
import { spokenLanguageName } from '@/lib/spoken-language';
import { colors, font } from '@/theme';

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

function tomorrowAtTen() {
  const next = new Date(Date.now() + 24 * 60 * 60 * 1000);
  next.setHours(10, 0, 0, 0);
  return next;
}

function requestId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16);
    return (character === 'x' ? random : (random & 0x3) | 0x8).toString(16);
  });
}

export default function CallSummary() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [call, setCall] = useState<MobileCallDetail>();
  const [aiState, setAiState] = useState<CallAiState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [recordingError, setRecordingError] = useState<string>();
  const [recordingUploaded, setRecordingUploaded] = useState(false);
  const [followupOpen, setFollowupOpen] = useState(false);
  const [reason, setReason] = useState('Follow up after call');
  const [dueAt, setDueAt] = useState(tomorrowAtTen);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const readyRecording = useMemo(
    () => call?.recordings.find((recording) => recording.object_file_id) ?? null,
    [call],
  );
  const canScheduleFollowup = Boolean(call?.lead_id || call?.customer_id);
  // A call with no lead yet (a synced phone recording) still knows its number.
  const phone = call?.phone ?? (call && !call.lead_id ? aiState?.phone : null) ?? null;
  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(false);
    try {
      const [detail, state] = await Promise.all([
        fetchMobileCallDetail(id),
        fetchCallAiState(id).catch(() => null),
      ]);
      setCall(detail);
      setAiState(state);
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
    if (phone) void Linking.openURL(`tel:${phone.replace(/[^+\d]/g, '')}`);
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
    const date = dueAt;
    if (reason.trim().length < 3) {
      setFormError('Enter a reason for the follow-up.');
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
    <Screen title="Call summary" subtitle={call ? dateTime(call.started_at) : undefined} back>
      {loading && !call ? <SkeletonList rows={5} /> : null}
      {error ? (
        <ErrorState
          title="Call detail is unavailable"
          detail="It may be outside your current permission or data scope."
          onRetry={() => void load()}
        />
      ) : null}
      {call ? (
        <>
          <View style={styles.card}>
            <View style={styles.customerRow}>
              <View style={styles.customerAvatar}>
                <Text style={styles.customerAvatarText}>
                  {initials(call.customer_name ?? 'Customer')}
                </Text>
              </View>
              <View style={styles.customerMain}>
                <Text style={styles.customerName}>
                  {call.customer_name ?? (call.lead_id ? 'Restricted party' : 'New number')}
                </Text>
                {phone ? (
                  <Pressable onPress={callCustomer}>
                    <Text style={styles.phone}>{phone}</Text>
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
                <PrimaryButton
                  label="Open"
                  icon="play"
                  variant="secondary"
                  busy={downloading}
                  onPress={() => void downloadRecording()}
                />
              ) : call.call_source === 'PERSONAL_MANUAL' ? (
                <PrimaryButton
                  label="Upload"
                  icon="cloud-upload-outline"
                  variant="secondary"
                  busy={uploading}
                  onPress={() => void uploadRecording()}
                />
              ) : null}
            </View>
            {recordingError ? <Text style={styles.formError}>{recordingError}</Text> : null}
            {recordingUploaded ? (
              <Text style={styles.uploadSuccess}>Recording uploaded securely.</Text>
            ) : null}
          </View>

          {aiState ? (
            <CallAiPanel
              state={aiState}
              onStateChange={setAiState}
              onCompleted={() => void load()}
            />
          ) : null}
          <InsightCard
            title="AI call summary"
            tone={colors.violet}
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
              <PrimaryButton
                label="Schedule follow-up"
                icon="alarm-outline"
                onPress={() => setFollowupOpen(true)}
              />
            ) : (
              <Text style={styles.restricted}>
                This call is not linked to a lead or customer, so a follow-up cannot be scheduled
                from it.
              </Text>
            )}
          </View>
          {phone ? (
            <PrimaryButton
              label="Call customer"
              icon="call-outline"
              variant="secondary"
              onPress={callCustomer}
            />
          ) : null}
          {call.lead_id ? (
            <PrimaryButton
              label="Open linked lead"
              icon="person-outline"
              variant="secondary"
              onPress={() =>
                router.push({ pathname: '/lead/[id]', params: { id: call.lead_id as string } })
              }
            />
          ) : null}
        </>
      ) : null}
      {followupOpen ? (
        <Sheet
          title="Schedule follow-up"
          subtitle="Created through the audited follow-up workflow and assigned to you."
          onClose={() => setFollowupOpen(false)}
          footer={
            <PrimaryButton
              label="Schedule"
              icon="alarm"
              busy={saving}
              style={styles.grow}
              onPress={() => void scheduleFollowup()}
            />
          }
        >
          <Text style={styles.inputLabel}>Reason</Text>
          <TextInput
            value={reason}
            onChangeText={setReason}
            style={styles.input}
            maxLength={240}
            placeholder="Reason for follow-up"
            placeholderTextColor={colors.faint}
          />
          <Text style={styles.inputLabel}>When</Text>
          <WhenPicker value={dueAt} onChange={setDueAt} />
          {formError ? <Text style={styles.formError}>{formError}</Text> : null}
        </Sheet>
      ) : null}
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
  const [showOriginal, setShowOriginal] = useState(false);
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
  const diarized = transcript.speaker_separation_method === 'PROVIDER_DIARIZATION';
  const translated = transcript.speaker_turns.some(
    (turn) => turn.original_text && turn.original_text.trim() !== turn.text.trim(),
  );
  const spoken = spokenLanguageName(transcript.language);
  return (
    <View style={styles.card}>
      <Text style={[styles.insightTitle, { color: colors.primary }]}>Transcript</Text>
      {translated ? (
        <Pressable onPress={() => setShowOriginal((value) => !value)} accessibilityRole="button">
          <Text style={styles.languageToggle}>
            {showOriginal
              ? `Spoken in ${spoken} · Show English`
              : `Translated from ${spoken} · Show original`}
          </Text>
        </Pressable>
      ) : null}
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
              <Text style={styles.speakerText}>
                {showOriginal && turn.original_text ? turn.original_text : turn.text}
              </Text>
            </View>
          );
        })}
      </View>
      {transcript.speaker_separation_method ? (
        <Text style={styles.insightNote}>
          {channelSeparated
            ? 'Speaker labels are based on separated call channels.'
            : diarized
              ? 'Voices were separated from the recording; AI decided which voice is the agent.'
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
  grow: { flex: 1 },
  languageToggle: { color: colors.primary, fontSize: font.label, fontWeight: '700' },
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
  customerAvatarText: { color: '#be123c', fontWeight: '600', fontSize: font.title },
  customerMain: { flex: 1 },
  customerName: { color: colors.navy, fontSize: font.large, fontWeight: '700' },
  phone: { color: colors.success, fontWeight: '700', marginTop: 4 },
  context: { color: colors.muted, fontSize: font.caption, marginTop: 5 },
  restricted: { color: colors.muted, fontSize: font.label, lineHeight: 18 },
  divider: { height: 1, backgroundColor: colors.border },
  source: { color: colors.muted, fontSize: font.caption, fontWeight: '700' },
  factRow: { flexDirection: 'row', gap: 8 },
  fact: {
    flex: 1,
    minHeight: 64,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  factValue: { color: colors.text, fontSize: font.label, fontWeight: '600', textAlign: 'center' },
  factLabel: { color: colors.muted, fontSize: font.caption, fontWeight: '700', marginTop: 6 },
  recording: {
    borderTopColor: colors.border,
    borderTopWidth: 1,
    paddingTop: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  recordingMain: { flex: 1 },
  recordingTitle: { color: colors.text, fontWeight: '600' },
  recordingText: { color: colors.muted, fontSize: font.caption, marginTop: 3 },
  insightTitle: { fontWeight: '600', fontSize: font.heading },
  insightText: { color: colors.text, fontSize: font.small, lineHeight: 20 },
  insightNote: { color: colors.warning, fontSize: font.caption, lineHeight: 16 },
  speakerTurns: { gap: 8 },
  speakerBubble: {
    maxWidth: '88%',
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 11,
    paddingVertical: 9,
  },
  agentBubble: {
    alignSelf: 'flex-start',
    borderColor: colors.infoBorderStrong,
    backgroundColor: colors.infoSoft,
  },
  customerBubble: {
    alignSelf: 'flex-end',
    borderColor: '#a7f3d0',
    backgroundColor: colors.successSoft,
  },
  unclearBubble: {
    alignSelf: 'flex-start',
    borderColor: colors.warningBorder,
    backgroundColor: colors.warningSoft,
  },
  speakerLabel: { fontSize: font.caption, fontWeight: '600', textTransform: 'uppercase' },
  agentLabel: { color: colors.primary },
  customerLabel: { color: colors.successStrong },
  unclearLabel: { color: colors.warningDeep },
  speakerText: { color: colors.text, fontSize: font.small, lineHeight: 20, marginTop: 4 },
  nextTitle: { color: colors.navy, fontSize: font.heading, fontWeight: '600' },
  nextText: { color: colors.muted, fontSize: font.label, lineHeight: 18 },
  success: { color: colors.success, fontSize: font.label, fontWeight: '600' },
  inputLabel: { color: colors.text, fontSize: font.label, fontWeight: '600', marginTop: 4 },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    minHeight: 44,
    paddingHorizontal: 11,
    color: colors.text,
    backgroundColor: colors.onColor,
  },
  formError: { color: colors.danger, fontSize: font.label },
  uploadSuccess: { color: colors.success, fontSize: font.label },
});
