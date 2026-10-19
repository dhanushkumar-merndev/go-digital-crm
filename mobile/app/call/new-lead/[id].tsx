import * as Crypto from 'expo-crypto';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Screen } from '@/components/screen';
import {
  callAiErrorMessage,
  callAiFieldLabels,
  createLeadFromCallReview,
  displayAiValue,
  fetchCallAiReview,
  type CallAiDecision,
  type CallAiField,
  type CallAiReview,
} from '@/lib/call-ai';
import { colors } from '@/theme';

const identityFields = new Set(['customer_name', 'phone', 'email', 'interested_model']);

function suggestion(review: CallAiReview | null, key: string) {
  const value = review?.extraction?.fields.find(
    (field) => field.field_key === key,
  )?.suggested_value;
  return typeof value === 'string' ? value : '';
}

// A new lead for a call whose number has no lead yet. Name, email and model are
// pre-filled from the call's AI suggestions and stay editable; every other
// suggestion is applied only if the user ticks it.
export default function NewLeadFromCall() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [review, setReview] = useState<CallAiReview | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [model, setModel] = useState('');
  const [accepted, setAccepted] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [requestId] = useState(() => Crypto.randomUUID());

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setLoadError(false);
    try {
      const data = await fetchCallAiReview(id);
      setReview(data);
      setName(suggestion(data, 'customer_name'));
      setEmail(suggestion(data, 'email'));
      setModel(suggestion(data, 'interested_model'));
      setAccepted(
        Object.fromEntries(
          (data.extraction?.fields ?? [])
            .filter((field) => !identityFields.has(field.field_key))
            .map((field) => [field.field_key, true]),
        ),
      );
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const otherFields = useMemo<CallAiField[]>(
    () =>
      (review?.extraction?.fields ?? []).filter((field) => !identityFields.has(field.field_key)),
    [review],
  );

  const save = async () => {
    if (!id) return;
    if (name.trim().length < 2) {
      setError('Enter the customer name.');
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const decisions: CallAiDecision[] = otherFields.map((field) => ({
        field_key: field.field_key,
        decision: accepted[field.field_key] ? 'APPLIED' : 'REJECTED',
      }));
      const created = await createLeadFromCallReview({
        callId: id,
        customerName: name.trim(),
        email: email.trim() || null,
        interestedModel: model.trim() || null,
        decisions,
        requestId,
      });
      router.replace({ pathname: '/lead/[id]', params: { id: created.lead_id } });
    } catch (saveError) {
      setError(callAiErrorMessage(saveError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen
      title="New lead from call"
      subtitle={review?.call.phone || 'Phone call recording'}
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
          <Text style={styles.errorTitle}>This call could not be loaded</Text>
          <Text style={styles.errorText}>Tap to retry.</Text>
        </Pressable>
      ) : null}
      {review ? (
        <>
          {review.summary ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Call summary</Text>
              <Text style={styles.body}>{review.summary}</Text>
            </View>
          ) : null}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Lead details</Text>
            {review.extraction ? (
              <Text style={styles.hint}>Filled from the call. Check and edit before saving.</Text>
            ) : (
              <Text style={styles.hint}>
                No AI suggestions for this call. Enter the details yourself.
              </Text>
            )}
            <Text style={styles.label}>Phone</Text>
            <Text style={styles.readonly}>{review.call.phone || '—'}</Text>
            <Text style={styles.label}>Customer name</Text>
            <TextInput
              value={name}
              onChangeText={setName}
              style={styles.input}
              placeholder="Customer name"
              maxLength={200}
            />
            <Text style={styles.label}>Email (optional)</Text>
            <TextInput
              value={email}
              onChangeText={setEmail}
              style={styles.input}
              placeholder="name@example.com"
              autoCapitalize="none"
              keyboardType="email-address"
              maxLength={320}
            />
            <Text style={styles.label}>Interested model (optional)</Text>
            <TextInput
              value={model}
              onChangeText={setModel}
              style={styles.input}
              placeholder="Model"
              maxLength={200}
            />
          </View>
          {otherFields.length ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Also apply from the call</Text>
              {otherFields.map((field) => (
                <View key={field.field_key} style={styles.toggleRow}>
                  <View style={styles.toggleMain}>
                    <Text style={styles.toggleLabel}>{callAiFieldLabels[field.field_key]}</Text>
                    <Text style={styles.toggleValue}>{displayAiValue(field.suggested_value)}</Text>
                  </View>
                  <Switch
                    value={Boolean(accepted[field.field_key])}
                    onValueChange={(value) =>
                      setAccepted((current) => ({ ...current, [field.field_key]: value }))
                    }
                  />
                </View>
              ))}
            </View>
          ) : null}
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Pressable style={styles.primary} onPress={() => void save()} disabled={saving}>
            <Text style={styles.primaryText}>{saving ? 'Creating…' : 'Create lead'}</Text>
          </Pressable>
        </>
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
    gap: 8,
  },
  cardTitle: { color: colors.navy, fontSize: 16, fontWeight: '800' },
  body: { color: colors.text, fontSize: 13, lineHeight: 20 },
  hint: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  label: { color: colors.text, fontSize: 12, fontWeight: '800', marginTop: 6 },
  readonly: { color: colors.text, fontSize: 14, fontWeight: '700' },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    minHeight: 44,
    paddingHorizontal: 11,
    color: colors.text,
    backgroundColor: '#fff',
  },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 },
  toggleMain: { flex: 1 },
  toggleLabel: { color: colors.muted, fontSize: 11, fontWeight: '700' },
  toggleValue: { color: colors.text, fontSize: 14, fontWeight: '700', marginTop: 2 },
  error: { color: colors.danger, fontSize: 13 },
  primary: { backgroundColor: colors.primary, alignItems: 'center', padding: 14, borderRadius: 11 },
  primaryText: { color: 'white', fontWeight: '800' },
});
