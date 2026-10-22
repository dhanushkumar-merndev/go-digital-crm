import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Screen } from '@/components/screen';
import { Chip, PrimaryButton } from '@/components/ui/basics';
import { useCallFlow } from '@/features/call-flow/call-flow';
import {
  createMobileLead,
  fetchLeadCreateBranches,
  leadCreateErrorMessage,
  leadSources,
  type LeadCreateBranch,
  type LeadSource,
} from '@/lib/lead-create';
import { colors, font, space } from '@/theme';

// Add a walk-in or phone enquiry from the field. Same rules as the web form:
// name, mobile and model are required, a phone match is never merged into an
// existing customer here, and the server resolves the creator's team.
export default function NewLead() {
  const { changed } = useCallFlow();
  const [branches, setBranches] = useState<LeadCreateBranch[]>([]);
  const [branchId, setBranchId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [model, setModel] = useState('');
  const [source, setSource] = useState<LeadSource>('Manual');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const rows = await fetchLeadCreateBranches();
      setBranches(rows);
      setBranchId((current) => current ?? rows[0]?.id);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const branch = branches.find((item) => item.id === branchId);

  const save = async () => {
    if (name.trim().length < 2) return setError('Enter the customer name.');
    if (phone.replace(/\D/g, '').length < 10) return setError('Enter a 10-digit mobile number.');
    if (!model.trim()) return setError('Enter the model the customer asked about.');
    if (!branch) return setError('No branch is available for your account.');
    setSaving(true);
    setError(undefined);
    try {
      const leadId = await createMobileLead({
        branch,
        source,
        customerName: name,
        phone,
        interestedModel: model,
      });
      changed('edit');
      router.replace({ pathname: '/lead/[id]', params: { id: leadId } });
    } catch (saveError) {
      setError(leadCreateErrorMessage(saveError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen title="Add lead" subtitle="One enquiry for one vehicle" back>
      {loading ? (
        <View style={styles.loading}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : loadError ? (
        <Pressable style={styles.errorCard} onPress={() => void load()}>
          <Text style={styles.errorTitle}>Branches could not load</Text>
          <Text style={styles.errorText}>Tap to retry.</Text>
        </Pressable>
      ) : (
        <>
          <View style={styles.card}>
            <Text style={styles.label}>Customer name</Text>
            <TextInput
              value={name}
              onChangeText={setName}
              style={styles.input}
              placeholder="Full name"
              placeholderTextColor={colors.faint}
              autoComplete="name"
              maxLength={160}
            />
            <Text style={styles.label}>Mobile number</Text>
            <TextInput
              value={phone}
              onChangeText={setPhone}
              style={styles.input}
              placeholder="98765 43210"
              placeholderTextColor={colors.faint}
              keyboardType="phone-pad"
              autoComplete="tel"
              maxLength={24}
            />
            <Text style={styles.label}>Interested model</Text>
            <TextInput
              value={model}
              onChangeText={setModel}
              style={styles.input}
              placeholder="e.g. Nexon"
              placeholderTextColor={colors.faint}
              maxLength={200}
            />
          </View>
          <View style={styles.card}>
            <Text style={styles.label}>Source</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.chips}
            >
              {leadSources.map((item) => (
                <Chip
                  key={item}
                  label={item}
                  selected={source === item}
                  onPress={() => setSource(item)}
                />
              ))}
            </ScrollView>
            {branches.length > 1 ? (
              <>
                <Text style={styles.label}>Branch</Text>
                <View style={styles.wrap}>
                  {branches.map((item) => (
                    <Chip
                      key={item.id}
                      label={item.name}
                      selected={branchId === item.id}
                      onPress={() => setBranchId(item.id)}
                    />
                  ))}
                </View>
              </>
            ) : null}
          </View>
          <Text style={styles.hint}>
            An existing customer with this number is shown on the lead to link; it is never merged
            automatically.
          </Text>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <PrimaryButton
            label="Add lead"
            icon="person-add"
            onPress={() => void save()}
            busy={saving}
          />
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  loading: { padding: 36, alignItems: 'center' },
  errorCard: {
    borderColor: colors.dangerBorder,
    borderWidth: 1,
    backgroundColor: colors.dangerSoft,
    borderRadius: 14,
    padding: 16,
  },
  errorTitle: { color: colors.dangerDeep, fontWeight: '600' },
  errorText: { color: colors.dangerStrong, fontSize: font.label, marginTop: 4 },
  card: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 16,
    padding: 15,
    gap: 8,
  },
  label: { color: colors.text, fontSize: font.label, fontWeight: '600', marginTop: 6 },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    minHeight: 44,
    paddingHorizontal: 11,
    color: colors.text,
    backgroundColor: colors.onColor,
  },
  chips: { gap: space.sm },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  hint: { color: colors.muted, fontSize: font.label, lineHeight: 17 },
  error: { color: colors.danger, fontSize: font.small },
});
