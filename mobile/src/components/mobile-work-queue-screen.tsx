import { router } from 'expo-router';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeOutLeft } from 'react-native-reanimated';
import { ListScreen } from '@/components/screen';
import { SwipeRow } from '@/components/swipe-row';
import { Badge, Chip, PrimaryButton } from '@/components/ui/basics';
import { dateRange, FilterBar, useFilters } from '@/components/ui/filter-sheet';
import { RowIcon, RowIcons, RowPressable } from '@/components/ui/row';
import { Sheet } from '@/components/ui/sheet';
import { useToast } from '@/components/ui/toast';
import { WhenPicker } from '@/components/ui/when-picker';
import { useCallFlow, useWorkRefresh } from '@/features/call-flow/call-flow';
import { relativeWhen } from '@/components/lead-row';
import { followupFilterGroups, orNull, safeSearch, taskFilterGroups } from '@/lib/list-filters';
import { supabase } from '@/lib/supabase';
import { pageSize, usePagedList } from '@/lib/use-paged-list';
import {
  completeFollowup,
  completeTask,
  isVersionConflict,
  rescheduleFollowup,
  rescheduleTask,
} from '@/lib/work-actions';
import { colors, font, priorityTone, space } from '@/theme';

type QueueKind = 'followups' | 'tasks';
type QueueTab = 'overdue' | 'today' | 'upcoming';
type QueueRow = {
  id: string;
  version: number;
  leadId: string | null;
  phone: string | null;
  // Who a call reaches; a task's title is the job, not the person.
  name: string;
  title: string;
  detail: string;
  dueAt: string | null;
  priority: string;
};
type QueueRecord = {
  id: string;
  version: number;
  lead_id: string | null;
  phone: string | null;
  customer_name: string | null;
  interested_model: string | null;
  reason?: string | null;
  title?: string | null;
  description?: string | null;
  due_at: string | null;
  priority: string;
};
const tabs: Array<{ value: QueueTab; label: string }> = [
  { value: 'overdue', label: 'Overdue' },
  { value: 'today', label: 'Today' },
  { value: 'upcoming', label: 'Upcoming' },
];
const UNDO_MS = 4000;

function deviceTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata';
}

function toRow(kind: QueueKind, record: QueueRecord): QueueRow {
  const base = {
    id: record.id,
    version: Number(record.version),
    leadId: record.lead_id,
    phone: record.phone,
    name: record.customer_name || record.phone || 'Customer',
    dueAt: record.due_at,
    priority: record.priority,
  };
  return kind === 'followups'
    ? {
        ...base,
        title: record.customer_name || 'Customer follow-up',
        detail: [record.reason, record.interested_model].filter(Boolean).join(' · '),
      }
    : {
        ...base,
        title: record.title || 'Task',
        detail:
          [record.customer_name, record.interested_model].filter(Boolean).join(' · ') ||
          record.description ||
          '',
      };
}

export function MobileWorkQueueScreen({ kind, bare }: { kind: QueueKind; bare?: boolean }) {
  const [tab, setTab] = useState<QueueTab>('overdue');
  const [later, setLater] = useState<QueueRow>();
  const [search, setSearch] = useState('');
  const filters = useFilters(kind === 'followups' ? followupFilterGroups : taskFilterGroups);
  const { values } = filters;
  const toast = useToast();
  const { call, changed } = useCallFlow();
  const pendingDone = useRef(
    new Map<string, { timer: ReturnType<typeof setTimeout>; commit: () => void }>(),
  );
  // The web workspace RPCs resolve the caller's scope once. Reading the
  // tables directly ran the RLS checks on every row in the organization;
  // follow-ups hit the 8 s statement timeout.
  const fetchPage = useCallback(
    async (page: number) => {
      const { data, error } =
        kind === 'followups'
          ? await supabase.rpc('get_followup_workspace_filtered_page', {
              target_search: safeSearch(search),
              target_status: tab,
              target_priority: values.priority,
              target_temperature: values.temperature,
              target_source: orNull(values.source) ?? '',
              target_model: orNull(values.model) ?? '',
              target_followup_from: dateRange(values.due).from,
              target_followup_to: dateRange(values.due).to,
              target_buyer_type: values.buyer,
              target_page: page,
              target_page_size: pageSize,
              target_sort: 'scheduled:asc',
              target_timezone: deviceTimezone(),
            })
          : await supabase.rpc('get_task_workspace_page', {
              target_search: safeSearch(search),
              target_priority: values.priority,
              target_status: tab.toUpperCase(),
              target_page: page,
              target_page_size: pageSize,
              target_sort: 'due:asc',
              target_timezone: deviceTimezone(),
            });
      if (error || !data) throw error ?? new Error('QUEUE_UNAVAILABLE');
      const result = data as {
        records?: QueueRecord[] | null;
        total?: number | null;
        status_counts?: Record<string, number> | null;
      };
      return {
        records: (result.records ?? []).map((record) => toRow(kind, record)),
        total: Number(result.total ?? 0),
        counts: result.status_counts ?? undefined,
      };
    },
    [kind, search, tab, values],
  );
  const list = usePagedList(fetchPage, { debounceMs: 300 });
  const narrowed = Boolean(search.trim()) || filters.active > 0;
  const { refresh, remove, reload } = list;
  useWorkRefresh(refresh);
  useEffect(() => {
    const pending = pendingDone.current;
    // Leaving the screen inside the Undo window still saves the change.
    return () =>
      pending.forEach(({ timer, commit }) => {
        clearTimeout(timer);
        commit();
      });
  }, []);
  const failed = useCallback(
    (error: unknown) => {
      toast({
        tone: 'error',
        message: isVersionConflict(error)
          ? 'Updated elsewhere, list refreshed.'
          : 'Could not save. Check your connection.',
      });
      reload();
    },
    [reload, toast],
  );
  // The row leaves at once; the mutation waits out the Undo window.
  const done = useCallback(
    (row: QueueRow) => {
      remove(row.id, tab);
      const commit = () => {
        pendingDone.current.delete(row.id);
        const action = kind === 'followups' ? completeFollowup(row) : completeTask(row);
        action.then(() => changed('edit')).catch(failed);
      };
      pendingDone.current.set(row.id, { timer: setTimeout(commit, UNDO_MS), commit });
      toast({
        message: kind === 'followups' ? 'Follow-up done' : 'Task done',
        durationMs: UNDO_MS,
        action: {
          label: 'Undo',
          onPress: () => {
            clearTimeout(pendingDone.current.get(row.id)?.timer);
            pendingDone.current.delete(row.id);
            reload();
          },
        },
      });
    },
    [changed, failed, kind, reload, remove, tab, toast],
  );
  const counts = list.counts;
  const noun = kind === 'followups' ? 'follow-ups' : 'tasks';
  const callRow = useCallback(
    (row: QueueRow) =>
      row.phone &&
      call({
        leadId: row.leadId,
        phone: row.phone,
        name: row.name,
        followup: kind === 'followups' ? row : undefined,
      }),
    [call, kind],
  );
  const overdue = tab === 'overdue';
  const renderItem = useCallback(
    ({ item }: { item: QueueRow }) => (
      <QueueItem row={item} overdue={overdue} onCall={callRow} onDone={done} onLater={setLater} />
    ),
    [callRow, done, overdue],
  );
  return (
    <>
      <ListScreen
        bare={bare}
        title={kind === 'followups' ? 'Follow-ups' : 'Tasks'}
        toolbar={
          <>
            <FilterBar
              search={search}
              onSearch={setSearch}
              placeholder={kind === 'followups' ? 'Search name or phone' : 'Search tasks'}
              filters={filters}
            />
            <View style={styles.chips}>
              {tabs.map((item) => (
                <Chip
                  key={item.value}
                  label={item.label}
                  count={counts?.[item.value]}
                  selected={tab === item.value}
                  onPress={() => setTab(item.value)}
                />
              ))}
            </View>
          </>
        }
        data={list.items}
        keyExtractor={(row) => row.id}
        renderItem={renderItem}
        loading={list.loading}
        refreshing={list.refreshing}
        loadingMore={list.loadingMore}
        error={list.error}
        errorTitle={`${kind === 'followups' ? 'Follow-ups' : 'Tasks'} could not load`}
        emptyTitle={
          narrowed
            ? `No ${noun} match`
            : tab === 'overdue'
              ? 'Nothing overdue'
              : `No ${noun} ${tab}`
        }
        emptyDetail={
          narrowed
            ? 'Try fewer filters or another tab.'
            : tab === 'overdue'
              ? 'You are all caught up.'
              : undefined
        }
        onRefresh={list.refresh}
        onEndReached={list.loadMore}
        onRetry={list.reload}
      />
      {later ? (
        <LaterSheet
          row={later}
          onClose={() => setLater(undefined)}
          onSave={async (dueAt) => {
            try {
              await (kind === 'followups'
                ? rescheduleFollowup({ ...later, dueAt })
                : rescheduleTask({ ...later, dueAt }));
              setLater(undefined);
              toast({ message: `Moved to ${relativeWhen(dueAt.toISOString())}` });
              refresh();
              changed('edit');
            } catch (error) {
              setLater(undefined);
              failed(error);
            }
          }}
        />
      ) : null}
    </>
  );
}

// Memoised: a page holds dozens of rows, and only the one that changed should
// render again.
const QueueItem = memo(function QueueItem({
  row,
  overdue,
  onCall,
  onDone,
  onLater,
}: {
  row: QueueRow;
  overdue: boolean;
  onCall: (row: QueueRow) => void;
  onDone: (row: QueueRow) => void;
  onLater: (row: QueueRow) => void;
}) {
  const urgent = row.priority === 'HIGH' || row.priority === 'URGENT';
  const when = relativeWhen(row.dueAt) ?? 'No due date';
  return (
    <Animated.View exiting={FadeOutLeft.duration(200)}>
      <SwipeRow
        left={
          row.phone
            ? { label: 'Call', icon: 'call', color: colors.success, onTrigger: () => onCall(row) }
            : undefined
        }
      >
        <RowPressable
          disabled={!row.leadId}
          onPress={() =>
            row.leadId && router.push({ pathname: '/lead/[id]', params: { id: row.leadId } })
          }
        >
          <View style={styles.main}>
            <View style={styles.line}>
              <Text numberOfLines={1} style={styles.title}>
                {row.title}
              </Text>
              {urgent ? <Badge label={row.priority} tone={priorityTone(row.priority)} /> : null}
            </View>
            {row.detail ? (
              <Text numberOfLines={1} style={styles.detail}>
                {row.detail}
              </Text>
            ) : null}
            <Text numberOfLines={1} style={[styles.due, overdue && styles.overdue]}>
              {overdue ? `Overdue · ${when}` : when}
            </Text>
          </View>
          <RowIcons>
            <RowIcon
              icon="checkmark-circle-outline"
              label="Mark done"
              color={colors.success}
              onPress={() => onDone(row)}
            />
            <RowIcon icon="alarm-outline" label="Do later" onPress={() => onLater(row)} />
            {row.phone ? (
              <RowIcon
                icon="call"
                label={`Call ${row.name}`}
                color={colors.primary}
                filled
                onPress={() => onCall(row)}
              />
            ) : null}
          </RowIcons>
        </RowPressable>
      </SwipeRow>
    </Animated.View>
  );
});

function LaterSheet({
  row,
  onClose,
  onSave,
}: {
  row: QueueRow;
  onClose: () => void;
  onSave: (dueAt: Date) => Promise<void>;
}) {
  const [value, setValue] = useState(() => {
    const next = new Date();
    next.setDate(next.getDate() + 1);
    next.setHours(10, 0, 0, 0);
    return next;
  });
  const [busy, setBusy] = useState(false);
  return (
    <Sheet
      title="Move to later"
      subtitle={row.title}
      onClose={onClose}
      footer={
        <PrimaryButton
          label="Move"
          icon="alarm"
          busy={busy}
          style={styles.grow}
          onPress={() => {
            setBusy(true);
            void onSave(value).finally(() => setBusy(false));
          }}
        />
      }
    >
      <WhenPicker value={value} onChange={setValue} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', gap: space.sm },
  main: { flex: 1, minWidth: 0, gap: 2 },
  line: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  title: { flexShrink: 1, color: colors.text, fontSize: font.body, fontWeight: '600' },
  detail: { color: colors.muted, fontSize: font.small },
  due: { color: colors.faint, fontSize: font.label, fontWeight: '500' },
  overdue: { color: colors.danger },
  grow: { flex: 1 },
});
