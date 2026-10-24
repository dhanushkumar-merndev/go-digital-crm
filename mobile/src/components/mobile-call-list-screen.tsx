import { router } from 'expo-router';
import { memo, useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { RecordingSyncButton } from '@/components/recording-sync-button';
import { ListScreen } from '@/components/screen';
import { Avatar, Badge } from '@/components/ui/basics';
import { FilterBar, useFilters } from '@/components/ui/filter-sheet';
import { Icon } from '@/components/ui/icon';
import { PressableScale } from '@/components/ui/pressable-scale';
import { RowPressable } from '@/components/ui/row';
import { fetchMobileCalls } from '@/lib/calls';
import { callFilterGroups, safeSearch } from '@/lib/list-filters';
import { usePagedList } from '@/lib/use-paged-list';
import { colors, font, space, type Tone } from '@/theme';

const stamp = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
});

function duration(value: number | null) {
  if (value === null) return null;
  return `${Math.floor(value / 60)}m ${(value % 60).toString().padStart(2, '0')}s`;
}

// NO_ANSWER reads "No answer", matching the outcome labels elsewhere.
function sentenceCase(value: string) {
  const text = value.replaceAll('_', ' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function outcomeTone(outcome: string): Tone {
  if (/CONNECTED|COMPLETED|ANSWERED/.test(outcome))
    return { fg: colors.successStrong, bg: colors.successSoft };
  if (/NO_ANSWER|BUSY|MISSED|FAILED/.test(outcome))
    return { fg: colors.warningStrong, bg: colors.warningSoft };
  return { fg: '#4b5563', bg: '#f3f4f6' };
}

type CallItem = Awaited<ReturnType<typeof fetchMobileCalls>>['records'][number];

const CallRow = memo(function CallRow({ item }: { item: CallItem }) {
  const outcome = item.outcome ?? item.status;
  // A call from a number with no lead yet reads as the call screen names it.
  const name = item.customer_name ?? item.phone ?? 'New number';
  const started = new Date(item.started_at);
  return (
    <RowPressable onPress={() => router.push({ pathname: '/call/[id]', params: { id: item.id } })}>
      <Avatar name={name} tone={{ fg: colors.primary, bg: colors.primarySoft }} size={38} />
      <View style={styles.main}>
        <View style={styles.line}>
          <Text numberOfLines={1} style={styles.name}>
            {name}
          </Text>
          <Badge label={sentenceCase(outcome)} tone={outcomeTone(outcome)} />
        </View>
        <Text numberOfLines={1} style={styles.meta}>
          {[
            Number.isNaN(started.getTime()) ? null : stamp.format(started),
            duration(item.duration_seconds),
            item.ai_summary_available ? 'AI summary' : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </Text>
      </View>
      <Icon name="chevron-forward" size={18} color={colors.faint} />
    </RowPressable>
  );
});

function renderCall({ item }: { item: CallItem }) {
  return <CallRow item={item} />;
}

export function MobileCallListScreen() {
  const [search, setSearch] = useState('');
  const filters = useFilters(callFilterGroups);
  const { values } = filters;
  const fetchPage = useCallback(
    (page: number) =>
      fetchMobileCalls(page, {
        search: safeSearch(search),
        view: values.view,
        outcome: values.outcome,
        source: values.source,
      }),
    [search, values],
  );
  const list = usePagedList(fetchPage, { debounceMs: 300 });
  const narrowed = Boolean(search.trim()) || filters.active > 0;
  return (
    <ListScreen
      back
      title="Call history"
      subtitle={
        list.total
          ? `${list.total.toLocaleString('en-IN')} ${narrowed ? 'matching calls' : 'calls'}`
          : undefined
      }
      action={
        <View style={styles.headerActions}>
          <RecordingSyncButton />
          <PressableScale
            onPress={() => router.push('/recordings')}
            style={styles.headerAction}
            accessibilityLabel="Call recordings"
          >
            <Icon name="mic-outline" size={18} color={colors.primary} />
          </PressableScale>
        </View>
      }
      toolbar={
        <FilterBar
          search={search}
          onSearch={setSearch}
          placeholder="Search name or phone"
          filters={filters}
        />
      }
      data={list.items}
      keyExtractor={(call) => call.id}
      renderItem={renderCall}
      loading={list.loading}
      refreshing={list.refreshing}
      loadingMore={list.loadingMore}
      error={list.error}
      errorTitle="Calls could not load"
      emptyTitle={narrowed ? 'No call matches' : 'No calls yet'}
      emptyIcon="call-outline"
      onRefresh={list.refresh}
      onEndReached={list.loadMore}
      onRetry={list.reload}
    />
  );
}

const styles = StyleSheet.create({
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  headerAction: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  main: { flex: 1, minWidth: 0, gap: 2 },
  line: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  name: { flexShrink: 1, color: colors.text, fontSize: font.body, fontWeight: '600' },
  meta: { color: colors.muted, fontSize: font.small },
});
