import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Chip, PrimaryButton } from '@/components/ui/basics';
import { Icon } from '@/components/ui/icon';
import { PressableScale } from '@/components/ui/pressable-scale';
import { Sheet } from '@/components/ui/sheet';
import { colors, font, radius, space } from '@/theme';

// Every group maps to a parameter the list's RPC already accepts, so a filter
// narrows the server query and the total; nothing is filtered in the app.
export type FilterGroup =
  | {
      key: string;
      label: string;
      kind: 'choice';
      options: ReadonlyArray<{ value: string; label: string }>;
    }
  | { key: string; label: string; kind: 'text'; placeholder: string }
  | { key: string; label: string; kind: 'dates'; options?: ReadonlyArray<DatePreset> };

export type FilterValues = Record<string, string>;

export type DatePreset = 'any' | 'today' | 'next7' | 'past7' | 'month';

const datePresetLabels: Record<DatePreset, string> = {
  any: 'Any time',
  today: 'Today',
  next7: 'Next 7 days',
  past7: 'Last 7 days',
  month: 'This month',
};

function defaultValue(group: FilterGroup) {
  if (group.kind === 'choice') return group.options[0]?.value ?? '';
  if (group.kind === 'dates') return 'any';
  return '';
}

export function filterDefaults(groups: ReadonlyArray<FilterGroup>): FilterValues {
  return Object.fromEntries(groups.map((group) => [group.key, defaultValue(group)]));
}

export function activeFilterCount(groups: ReadonlyArray<FilterGroup>, values: FilterValues) {
  return groups.filter((group) => (values[group.key] ?? '') !== defaultValue(group)).length;
}

function isoDate(value: Date) {
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${value.getFullYear()}-${month}-${day}`;
}

/** Inclusive local-date bounds for a preset, as the RPCs' `date` parameters expect. */
export function dateRange(preset: string | undefined, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const shift = (days: number) =>
    new Date(today.getFullYear(), today.getMonth(), today.getDate() + days);
  switch (preset) {
    case 'today':
      return { from: isoDate(today), to: isoDate(today) };
    case 'next7':
      return { from: isoDate(today), to: isoDate(shift(6)) };
    case 'past7':
      return { from: isoDate(shift(-6)), to: isoDate(today) };
    case 'month':
      return {
        from: isoDate(new Date(today.getFullYear(), today.getMonth(), 1)),
        to: isoDate(new Date(today.getFullYear(), today.getMonth() + 1, 0)),
      };
    default:
      return { from: null, to: null };
  }
}

export function useFilters(groups: ReadonlyArray<FilterGroup>) {
  const defaults = useMemo(() => filterDefaults(groups), [groups]);
  const [values, setValues] = useState<FilterValues>(defaults);
  const [open, setOpen] = useState(false);
  return {
    groups,
    values,
    open,
    active: activeFilterCount(groups, values),
    show: () => setOpen(true),
    hide: () => setOpen(false),
    apply: (next: FilterValues) => {
      setValues(next);
      setOpen(false);
    },
    reset: () => setValues(defaults),
  };
}

export type Filters = ReturnType<typeof useFilters>;

/** Search box with a Filter button that shows how many filters are on. */
export function FilterBar({
  search,
  onSearch,
  placeholder,
  filters,
}: {
  search: string;
  onSearch: (value: string) => void;
  placeholder: string;
  filters: Filters;
}) {
  return (
    <View style={styles.bar}>
      <View style={styles.search}>
        <Icon name="search" size={18} color={colors.muted} />
        <TextInput
          value={search}
          onChangeText={onSearch}
          placeholder={placeholder}
          placeholderTextColor={colors.faint}
          returnKeyType="search"
          style={styles.input}
          accessibilityLabel={placeholder}
        />
        {search ? (
          <PressableScale onPress={() => onSearch('')} hitSlop={10} accessibilityLabel="Clear">
            <Icon name="close-circle" size={18} color={colors.faint} />
          </PressableScale>
        ) : null}
      </View>
      <PressableScale
        onPress={filters.show}
        style={[styles.filterButton, filters.active ? styles.filterButtonOn : null]}
        accessibilityRole="button"
        accessibilityLabel={filters.active ? `Filters, ${filters.active} on` : 'Filters'}
      >
        <Icon
          name="options-outline"
          size={20}
          color={filters.active ? colors.onColor : colors.text}
        />
        {filters.active ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{filters.active}</Text>
          </View>
        ) : null}
      </PressableScale>
      {filters.open ? <FilterSheet filters={filters} /> : null}
    </View>
  );
}

function FilterSheet({ filters }: { filters: Filters }) {
  const [draft, setDraft] = useState<FilterValues>(filters.values);
  const set = (key: string, value: string) => setDraft((current) => ({ ...current, [key]: value }));
  const draftActive = activeFilterCount(filters.groups, draft);
  return (
    <Sheet
      title="Filters"
      subtitle={draftActive ? `${draftActive} on` : 'Showing everything'}
      onClose={filters.hide}
      footer={
        <>
          <PrimaryButton
            label="Clear"
            variant="secondary"
            style={styles.grow}
            onPress={() => setDraft(filterDefaults(filters.groups))}
          />
          <PrimaryButton
            label="Show results"
            icon="checkmark"
            style={styles.grow}
            onPress={() => filters.apply(draft)}
          />
        </>
      }
    >
      {filters.groups.map((group) => (
        <View key={group.key} style={styles.group}>
          <Text style={styles.groupLabel}>{group.label}</Text>
          {group.kind === 'text' ? (
            <TextInput
              value={draft[group.key] ?? ''}
              onChangeText={(value) => set(group.key, value.slice(0, 80))}
              placeholder={group.placeholder}
              placeholderTextColor={colors.faint}
              style={styles.textField}
              accessibilityLabel={group.label}
            />
          ) : (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.chips}
            >
              {(group.kind === 'choice'
                ? group.options
                : (group.options ?? (['any', 'today', 'next7', 'month'] as const)).map(
                    (preset) => ({ value: preset, label: datePresetLabels[preset] }),
                  )
              ).map((option) => (
                <Chip
                  key={option.value}
                  label={option.label}
                  selected={(draft[group.key] ?? defaultValue(group)) === option.value}
                  onPress={() => set(group.key, option.value)}
                />
              ))}
            </ScrollView>
          )}
        </View>
      ))}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  search: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    height: 46,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  input: { flex: 1, color: colors.text, fontSize: font.body, paddingVertical: 0 },
  filterButton: {
    width: 46,
    height: 46,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  filterButtonOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  badge: {
    position: 'absolute',
    top: -6,
    right: -6,
    minWidth: 20,
    height: 20,
    paddingHorizontal: 5,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.success,
    borderWidth: 2,
    borderColor: colors.background,
  },
  badgeText: { color: colors.onColor, fontSize: 11, fontWeight: '700' },
  group: { gap: space.sm, marginBottom: space.lg },
  groupLabel: { color: colors.muted, fontSize: font.label, fontWeight: '600' },
  chips: { gap: space.sm },
  textField: {
    height: 46,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    color: colors.text,
    fontSize: font.body,
  },
  grow: { flex: 1 },
});
