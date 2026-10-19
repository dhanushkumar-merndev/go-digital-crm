import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Screen } from '@/components/screen';
import {
  callAiErrorMessage,
  callAiFieldLabels,
  displayAiValue,
  fetchCallAiReview,
  reviewCallAiFields,
  type CallAiDecision,
  type CallAiField,
  type CallAiReview,
} from '@/lib/call-ai';
import { colors } from '@/theme';

type Choice = { decision: 'APPLIED' | 'REJECTED' | 'EDITED'; value?: string };

// Suggest -> Review -> Apply for a call on an existing lead. Nothing changes on
// the lead until the user applies their choices; the server records each one.
export default function ReviewCallSuggestions() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [review, setReview] = useState<CallAiReview | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [savedFields, setSavedFields] = useState<string[] | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setLoadError(false);
    try {
      setReview(await fetchCallAiReview(id));
      setChoices({});
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const pending = (review?.extraction?.fields ?? []).filter(
    (field) => field.decision === 'PENDING',
  );
  const reviewed = (review?.extraction?.fields ?? []).filter(
    (field) => field.decision !== 'PENDING',
  );

  const choose = (field: CallAiField, choice: Choice | null) =>
    setChoices((current) => {
      const next = { ...current };
      if (choice) next[field.field_key] = choice;
      else delete next[field.field_key];
      return next;
    });

  const apply = async () => {
    if (!review?.extraction) return;
    const decisions: CallAiDecision[] = Object.entries(choices).map(([fieldKey, choice]) => ({
      field_key: fieldKey as CallAiDecision['field_key'],
      decision: choice.decision,
      ...(choice.decision === 'EDITED' ? { value: choice.value?.trim() ?? '' } : {}),
    }));
    if (!decisions.length) {
      setError('Choose Apply, Edit or Reject for at least one suggestion.');
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const result = await reviewCallAiFields(review.extraction.id, decisions);
      setSavedFields(result.accepted_fields);
      await load();
    } catch (applyError) {
      setError(callAiErrorMessage(applyError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen
      title="AI suggestions"
      subtitle={review?.call.customer_name ?? 'Call review'}
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
      {loadError ? (
        <Pressable style={styles.errorCard} onPress={() => void load()}>
          <Text style={styles.errorTitle}>Suggestions could not be loaded</Text>
          <Text style={styles.errorText}>Tap to retry.</Text>
        </Pressable>
      ) : null}
      {review && !review.extraction ? (
        <View style={styles.card}>
          <Text style={styles.body}>This call has no AI suggestions.</Text>
        </View>
      ) : null}
      {savedFields ? (
        <Text style={styles.success}>
          {savedFields.length
            ? `Updated: ${savedFields.map((key) => callAiFieldLabels[key as CallAiField['field_key']] ?? key).join(', ')}.`
            : 'Your review was saved. Nothing on the lead changed.'}
        </Text>
      ) : null}
      {pending.map((field) => {
        const choice = choices[field.field_key];
        return (
          <View key={field.field_key} style={styles.card}>
            <Text style={styles.fieldLabel}>{callAiFieldLabels[field.field_key]}</Text>
            <View style={styles.compare}>
              <View style={styles.compareSide}>
                <Text style={styles.compareCaption}>Now</Text>
                <Text style={styles.compareValue}>{displayAiValue(field.current_value)}</Text>
              </View>
              <Text style={styles.arrow}>→</Text>
              <View style={styles.compareSide}>
                <Text style={styles.compareCaption}>Suggested</Text>
                <Text style={[styles.compareValue, styles.suggested]}>
                  {displayAiValue(field.suggested_value)}
                </Text>
              </View>
            </View>
            {choice?.decision === 'EDITED' ? (
              <TextInput
                value={choice.value}
                onChangeText={(value) => choose(field, { decision: 'EDITED', value })}
                style={styles.input}
                autoFocus
              />
            ) : null}
            <View style={styles.choiceRow}>
              {(['APPLIED', 'EDITED', 'REJECTED'] as const).map((decision) => (
                <Pressable
                  key={decision}
                  style={[styles.choice, choice?.decision === decision && styles.choiceActive]}
                  onPress={() =>
                    choose(
                      field,
                      choice?.decision === decision
                        ? null
                        : {
                            decision,
                            value:
                              decision === 'EDITED'
                                ? field.suggested_value == null
                                  ? ''
                                  : String(field.suggested_value)
                                : undefined,
                          },
                    )
                  }
                >
                  <Text
                    style={[
                      styles.choiceText,
                      choice?.decision === decision && styles.choiceTextActive,
                    ]}
                  >
                    {decision === 'APPLIED' ? 'Apply' : decision === 'EDITED' ? 'Edit' : 'Reject'}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
        );
      })}
      {pending.length ? (
        <>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Pressable style={styles.primary} onPress={() => void apply()} disabled={saving}>
            <Text style={styles.primaryText}>
              {saving ? 'Applying…' : 'Apply selected changes'}
            </Text>
          </Pressable>
        </>
      ) : review?.extraction ? (
        <Text style={styles.body}>Every suggestion from this call has been reviewed.</Text>
      ) : null}
      {reviewed.length ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Already reviewed</Text>
          {reviewed.map((field) => (
            <Text key={field.field_key} style={styles.reviewedRow}>
              {callAiFieldLabels[field.field_key]}:{' '}
              {field.decision === 'REJECTED'
                ? 'rejected'
                : `${displayAiValue(field.applied_value)} (${field.decision === 'EDITED' ? 'edited' : 'applied'})`}
            </Text>
          ))}
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  back: { color: colors.primary, fontWeight: '700' },
  loading: { padding: 36, alignItems: 'center' },
  errorCard: {
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
    gap: 10,
  },
  cardTitle: { color: colors.navy, fontSize: 16, fontWeight: '800' },
  body: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  success: { color: colors.success, fontSize: 13, fontWeight: '700' },
  fieldLabel: { color: colors.navy, fontSize: 15, fontWeight: '800' },
  compare: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  compareSide: { flex: 1 },
  compareCaption: { color: colors.muted, fontSize: 10, fontWeight: '700' },
  compareValue: { color: colors.text, fontSize: 13, fontWeight: '700', marginTop: 2 },
  suggested: { color: '#7c3aed' },
  arrow: { color: colors.muted, fontSize: 16 },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    minHeight: 44,
    paddingHorizontal: 11,
    color: colors.text,
  },
  choiceRow: { flexDirection: 'row', gap: 8 },
  choice: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 9,
    paddingVertical: 9,
    alignItems: 'center',
  },
  choiceActive: { borderColor: colors.primary, backgroundColor: '#eff6ff' },
  choiceText: { color: colors.text, fontWeight: '700', fontSize: 12 },
  choiceTextActive: { color: colors.primary },
  error: { color: colors.danger, fontSize: 13 },
  primary: { backgroundColor: colors.primary, alignItems: 'center', padding: 14, borderRadius: 11 },
  primaryText: { color: 'white', fontWeight: '800' },
  reviewedRow: { color: colors.text, fontSize: 12, lineHeight: 18 },
});
