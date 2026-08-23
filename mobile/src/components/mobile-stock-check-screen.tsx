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
import { fetchMobileStockCheck, type MobileStockCheckPage } from '@/lib/stock-check';
import { colors } from '@/theme';

const filters = [
  ['ALL', 'All'],
  ['AVAILABLE', 'Available'],
  ['LIMITED', 'Limited'],
  ['INCOMING', 'Incoming'],
  ['UNAVAILABLE', 'Unavailable'],
] as const;

function availabilityTone(value: string) {
  if (value === 'AVAILABLE') return colors.success;
  if (value === 'LIMITED') return colors.warning;
  if (value === 'INCOMING') return colors.primary;
  return colors.danger;
}

export function MobileStockCheckScreen() {
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [availability, setAvailability] = useState<(typeof filters)[number][0]>('ALL');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<MobileStockCheckPage>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  useEffect(() => {
    const timeout = setTimeout(() => setSearch(searchInput), 300);
    return () => clearTimeout(timeout);
  }, [searchInput]);
  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      setResult(await fetchMobileStockCheck({ search, availability, page }));
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [availability, page, search]);
  useEffect(() => {
    void load();
  }, [load]);
  const setFilter = (value: (typeof filters)[number][0]) => {
    setAvailability(value);
    setPage(1);
  };

  return (
    <Screen title="Stock check" subtitle="Live inventory available in your authorized branches">
      <TextInput
        value={searchInput}
        onChangeText={(value) => {
          setSearchInput(value);
          setPage(1);
        }}
        style={styles.search}
        placeholder="Search model, variant, fuel or colour"
      />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.filters}
      >
        {filters.map(([value, label]) => (
          <Pressable
            key={value}
            onPress={() => setFilter(value)}
            style={[styles.filter, availability === value && styles.filterActive]}
          >
            <Text style={[styles.filterText, availability === value && styles.filterTextActive]}>
              {label}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
      {loading ? (
        <View style={styles.loading}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : null}
      {error ? (
        <Pressable style={styles.error} onPress={() => void load()}>
          <Text style={styles.errorTitle}>Stock check could not load</Text>
          <Text style={styles.errorText}>Tap to retry with your current authorized session.</Text>
        </Pressable>
      ) : null}
      {!loading && !error && result ? (
        <>
          <View style={styles.metrics}>
            <Metric label="Available" value={result.kpis.available_units} tone={colors.success} />
            <Metric label="Limited" value={result.kpis.limited_groups} tone={colors.warning} />
            <Metric label="Incoming" value={result.kpis.incoming_units} tone={colors.primary} />
            <Metric
              label="Unavailable"
              value={result.kpis.unavailable_groups}
              tone={colors.danger}
            />
          </View>
          <View style={styles.card}>
            {result.records.length ? (
              result.records.map((record) => (
                <View key={record.key} style={styles.row}>
                  <View style={styles.main}>
                    <Text style={styles.model}>
                      {[record.brand_name, record.model_name, record.variant_name]
                        .filter(Boolean)
                        .join(' ')}
                    </Text>
                    <Text style={styles.meta}>
                      {record.branch_name}
                      {record.color ? ` · ${record.color}` : ''}
                      {record.fuel ? ` · ${record.fuel}` : ''}
                    </Text>
                    <Text style={styles.units}>
                      {record.available} available · {record.incoming} incoming · {record.reserved}{' '}
                      reserved
                    </Text>
                  </View>
                  <Text
                    style={[styles.availability, { color: availabilityTone(record.availability) }]}
                  >
                    {record.availability}
                  </Text>
                </View>
              ))
            ) : (
              <Text style={styles.empty}>No stock groups match your filters.</Text>
            )}
          </View>
          <View style={styles.pagination}>
            <Pressable
              style={[styles.pageButton, page === 1 && styles.disabled]}
              disabled={page === 1}
              onPress={() => setPage((value) => value - 1)}
            >
              <Text style={styles.pageText}>Previous</Text>
            </Pressable>
            <Text style={styles.pageLabel}>
              Page {page} · {result.total} groups
            </Text>
            <Pressable
              style={[styles.pageButton, result.records.length < 25 && styles.disabled]}
              disabled={result.records.length < 25}
              onPress={() => setPage((value) => value + 1)}
            >
              <Text style={styles.pageText}>Next</Text>
            </Pressable>
          </View>
        </>
      ) : null}
    </Screen>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <View style={styles.metric}>
      <Text style={[styles.metricValue, { color: tone }]}>{value}</Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  search: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 11,
    backgroundColor: colors.card,
    paddingHorizontal: 12,
    color: colors.text,
    fontSize: 13,
  },
  filters: { gap: 8 },
  filter: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 999,
    backgroundColor: colors.card,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  filterActive: { backgroundColor: colors.navy, borderColor: colors.navy },
  filterText: { color: colors.muted, fontSize: 11, fontWeight: '800' },
  filterTextActive: { color: 'white' },
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
  metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  metric: {
    width: '48%',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 13,
    backgroundColor: colors.card,
    padding: 12,
  },
  metricValue: { fontSize: 22, fontWeight: '800' },
  metricLabel: { color: colors.muted, fontSize: 10, fontWeight: '700', marginTop: 4 },
  card: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 15,
    backgroundColor: colors.card,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    gap: 10,
    padding: 13,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  main: { flex: 1 },
  model: { color: colors.text, fontSize: 14, fontWeight: '800' },
  meta: { color: colors.muted, fontSize: 11, marginTop: 4 },
  units: { color: colors.text, fontSize: 11, marginTop: 5 },
  availability: { fontSize: 10, fontWeight: '800', maxWidth: 80, textAlign: 'right' },
  empty: { color: colors.muted, fontSize: 12, textAlign: 'center', padding: 24 },
  pagination: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  pageButton: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    paddingHorizontal: 13,
    paddingVertical: 9,
    borderRadius: 10,
  },
  disabled: { opacity: 0.45 },
  pageText: { color: colors.primary, fontSize: 12, fontWeight: '800' },
  pageLabel: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: '700',
    maxWidth: 145,
    textAlign: 'center',
  },
});
