import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Screen } from '@/components/screen';
import { Badge, Card, Chip, EmptyState, ErrorState, SkeletonList } from '@/components/ui/basics';
import { FilterBar } from '@/components/ui/filter-sheet';
import { fetchMobileStockCheck, type MobileStockCheckPage } from '@/lib/stock-check';
import { colors, font } from '@/theme';

const filters = [
  ['ALL', 'All'],
  ['AVAILABLE', 'Available'],
  ['LIMITED', 'Limited'],
  ['INCOMING', 'Incoming'],
  ['UNAVAILABLE', 'Unavailable'],
] as const;

const availabilityBadge: Record<string, { fg: string; bg: string }> = {
  AVAILABLE: { fg: colors.successStrong, bg: colors.successSoft },
  LIMITED: { fg: colors.warningStrong, bg: colors.warningSoft },
  INCOMING: { fg: colors.primary, bg: colors.infoSoft },
};

function availabilityLabel(value: string) {
  return value.charAt(0) + value.slice(1).toLowerCase();
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
    <Screen back title="Stock check">
      <FilterBar
        search={searchInput}
        onSearch={(value) => {
          setSearchInput(value);
          setPage(1);
        }}
        placeholder="Search model, variant, fuel or colour"
      />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.filters}
      >
        {filters.map(([value, label]) => (
          <Chip
            key={value}
            label={label}
            selected={availability === value}
            onPress={() => setFilter(value)}
          />
        ))}
      </ScrollView>
      {loading ? <SkeletonList /> : null}
      {error ? <ErrorState title="Stock check could not load" onRetry={() => void load()} /> : null}
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
          <Card>
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
                  <Badge
                    label={availabilityLabel(record.availability)}
                    tone={
                      availabilityBadge[record.availability] ?? {
                        fg: colors.dangerStrong,
                        bg: colors.dangerSoft,
                      }
                    }
                  />
                </View>
              ))
            ) : (
              <EmptyState
                icon="car-outline"
                title="No stock matches your filters"
                detail="Try another model or clear the availability filter."
              />
            )}
          </Card>
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
  filters: { gap: 8 },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  metric: {
    width: '48%',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 13,
    backgroundColor: colors.card,
    padding: 12,
  },
  metricValue: { fontSize: font.display, fontWeight: '700' },
  metricLabel: { color: colors.muted, fontSize: font.caption, fontWeight: '700', marginTop: 4 },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    padding: 13,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  main: { flex: 1 },
  model: { color: colors.text, fontSize: font.row, fontWeight: '600' },
  meta: { color: colors.muted, fontSize: font.caption, marginTop: 4 },
  units: { color: colors.text, fontSize: font.caption, marginTop: 5 },
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
  pageText: { color: colors.primary, fontSize: font.label, fontWeight: '600' },
  pageLabel: {
    color: colors.muted,
    fontSize: font.caption,
    fontWeight: '700',
    maxWidth: 145,
    textAlign: 'center',
  },
});
