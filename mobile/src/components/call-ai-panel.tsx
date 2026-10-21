import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  callAiErrorMessage,
  fetchCallAiState,
  isCallAiRunning,
  requestCallAiProcessing,
  type CallAiState,
} from '@/lib/call-ai';
import { colors, font } from '@/theme';

const pollEveryMs = 5000;

// Transcribe & summarise on demand, its progress, and what to do with the
// result: review the suggestions on the lead, or create a lead from the call.
export function CallAiPanel({
  state,
  onStateChange,
  onCompleted,
}: {
  state: CallAiState;
  onStateChange: (state: CallAiState) => void;
  onCompleted: () => void;
}) {
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState<string>();
  const running = isCallAiRunning(state);
  const wasRunning = useRef(running);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      fetchCallAiState(state.call_id)
        .then(onStateChange)
        .catch(() => undefined);
    }, pollEveryMs);
    return () => clearInterval(timer);
  }, [running, state.call_id, onStateChange]);

  useEffect(() => {
    if (wasRunning.current && !running && state.job?.status === 'COMPLETED') onCompleted();
    wasRunning.current = running;
  }, [running, state.job?.status, onCompleted]);

  const request = async (regenerate = false) => {
    setRequesting(true);
    setError(undefined);
    try {
      await requestCallAiProcessing(state.call_id, regenerate);
      onStateChange(await fetchCallAiState(state.call_id));
    } catch (requestError) {
      setError(callAiErrorMessage(requestError));
    } finally {
      setRequesting(false);
    }
  };

  const done = state.transcript_status === 'COMPLETED' && state.has_summary;
  const failed = state.job?.status === 'FAILED';

  return (
    <View style={styles.card}>
      <Text style={styles.title}>AI transcript & summary</Text>
      {!state.recording_ready ? (
        <Text style={styles.text}>Upload the call recording to transcribe and summarise it.</Text>
      ) : running ? (
        <View style={styles.progress}>
          <ActivityIndicator color="#7c3aed" />
          <Text style={styles.text}>
            {state.job?.status === 'RETRY'
              ? 'Retrying shortly…'
              : 'Transcribing, translating and summarising. This usually takes a few minutes.'}
          </Text>
        </View>
      ) : done ? (
        <Text style={styles.text}>The transcript and summary are below.</Text>
      ) : (
        <Text style={styles.text}>
          {state.auto_process
            ? 'Automatic processing is on, but this recording has not been processed.'
            : 'Processing runs only when you ask, so AI credits are spent on the calls that need it.'}
        </Text>
      )}
      {failed ? (
        <Text style={styles.error}>
          Processing failed: {callAiErrorMessage(state.job?.safe_error_code)}
        </Text>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {state.can_request ? (
        <Pressable
          style={styles.primary}
          onPress={() => void request(false)}
          disabled={requesting}
          accessibilityRole="button"
        >
          <Text style={styles.primaryText}>
            {requesting ? 'Starting…' : failed ? 'Try again' : 'Transcribe & summarise'}
          </Text>
        </Pressable>
      ) : null}
      {state.can_request ? (
        <Text style={styles.note}>
          {state.estimated_credits
            ? `About ${state.estimated_credits} AI credit${state.estimated_credits === 1 ? '' : 's'}, charged on the real call length.`
            : 'Charged by call length: about 1 AI credit per minute.'}
        </Text>
      ) : null}
      {done && state.can_create_lead ? (
        <Pressable
          style={styles.primary}
          onPress={() =>
            router.push({ pathname: '/call/new-lead/[id]', params: { id: state.call_id } })
          }
          accessibilityRole="button"
        >
          <Text style={styles.primaryText}>Create lead from this call</Text>
        </Pressable>
      ) : null}
      {!done && !running && state.can_create_lead ? (
        <Pressable
          style={styles.secondary}
          onPress={() =>
            router.push({ pathname: '/call/new-lead/[id]', params: { id: state.call_id } })
          }
          accessibilityRole="button"
        >
          <Text style={styles.secondaryText}>Create lead without AI</Text>
        </Pressable>
      ) : null}
      {state.lead_id && state.extraction_run_id ? (
        <Pressable
          style={styles.secondary}
          onPress={() =>
            router.push({ pathname: '/call/review/[id]', params: { id: state.call_id } })
          }
          accessibilityRole="button"
        >
          <Text style={styles.secondaryText}>Review AI suggestions</Text>
        </Pressable>
      ) : null}
      {state.can_regenerate && done ? (
        <Pressable onPress={() => void request(true)} disabled={requesting}>
          <Text style={styles.link}>Regenerate (uses AI credits)</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderColor: '#ddd6fe',
    borderWidth: 1,
    borderRadius: 16,
    padding: 15,
    gap: 10,
  },
  title: { color: colors.violet, fontWeight: '600', fontSize: font.heading },
  text: { color: colors.text, fontSize: font.small, lineHeight: 19, flex: 1 },
  progress: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  error: { color: colors.danger, fontSize: font.label, lineHeight: 17 },
  note: { color: colors.muted, fontSize: font.caption },
  primary: { backgroundColor: colors.violet, alignItems: 'center', padding: 13, borderRadius: 11 },
  primaryText: { color: colors.onColor, fontWeight: '600' },
  secondary: {
    borderWidth: 1,
    borderColor: colors.violet,
    alignItems: 'center',
    padding: 12,
    borderRadius: 11,
  },
  secondaryText: { color: colors.violet, fontWeight: '600' },
  link: { color: colors.muted, fontSize: font.label, fontWeight: '700', textAlign: 'center' },
});
