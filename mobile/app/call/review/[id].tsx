import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Screen } from '@/components/screen';
import { EmptyState, ErrorState, PrimaryButton, SkeletonList } from '@/components/ui/basics';
import {
  aiEditText,
  aiEditValue,
  callAiErrorMessage,
  callAiFieldLabels,
  displayAiValue,
  fetchCallAiReview,
  reviewCallAiFields,
  type CallAiDecision,
  type CallAiField,
  type CallAiFieldKey,
  type CallAiReview,
} from '@/lib/call-ai';
import { colors, font } from '@/theme';

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
      ...(choice.decision === 'EDITED'
        ? { value: aiEditValue(fieldKey as CallAiFieldKey, choice.value ?? '') }
        : {}),
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
    <Screen title="AI suggestions" subtitle={review?.call.customer_name ?? undefined} back>
      {loading ? <SkeletonList rows={4} /> : null}
      {loadError ? (
        <ErrorState title="Suggestions could not be loaded" onRetry={() => void load()} />
      ) : null}
      {review && !review.extraction ? (
        <EmptyState icon="sparkles-outline" title="This call has no AI suggestions." />
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
                <Text style={styles.compareValue}>
                  {displayAiValue(field.current_value, field.field_key)}
                </Text>
              </View>
              <Text style={styles.arrow}>→</Text>
              <View style={styles.compareSide}>
                <Text style={styles.compareCaption}>Suggested</Text>
                <Text style={[styles.compareValue, styles.suggested]}>
                  {displayAiValue(field.suggested_value, field.field_key)}
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
                                ? aiEditText(field.field_key, field.suggested_value)
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
          <PrimaryButton
            label="Apply selected changes"
            icon="checkmark"
            busy={saving}
            onPress={() => void apply()}
          />
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
                : `${displayAiValue(field.applied_value, field.field_key)} (${field.decision === 'EDITED' ? 'edited' : 'applied'})`}
            </Text>
          ))}
        </View>
      ) : null}
    </Screen>
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
  body: { color: colors.muted, fontSize: font.small, lineHeight: 19 },
  success: { color: colors.success, fontSize: font.small, fontWeight: '700' },
  fieldLabel: { color: colors.navy, fontSize: font.body, fontWeight: '600' },
  compare: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  compareSide: { flex: 1 },
  compareCaption: { color: colors.muted, fontSize: font.caption, fontWeight: '700' },
  compareValue: { color: colors.text, fontSize: font.small, fontWeight: '700', marginTop: 2 },
  suggested: { color: colors.violet },
  arrow: { color: colors.muted, fontSize: font.heading },
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
  choiceActive: { borderColor: colors.primary, backgroundColor: colors.infoSoft },
  choiceText: { color: colors.text, fontWeight: '700', fontSize: font.label },
  choiceTextActive: { color: colors.primary },
  error: { color: colors.danger, fontSize: font.small },
  reviewedRow: { color: colors.text, fontSize: font.label, lineHeight: 18 },
});
