import { router } from 'expo-router';
import { memo, useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ListScreen } from '@/components/screen';
import { SwipeRow } from '@/components/swipe-row';
import { Badge, Chip, PrimaryButton } from '@/components/ui/basics';
import { FilterBar, useFilters } from '@/components/ui/filter-sheet';
import { RowIcon, RowPressable } from '@/components/ui/row';
import { Sheet } from '@/components/ui/sheet';
import { useToast } from '@/components/ui/toast';
import { formatWhen, WhenPicker } from '@/components/ui/when-picker';
import { useCallFlow } from '@/features/call-flow/call-flow';
import { leadActionMessage } from '@/lib/lead-detail';
import { safeSearch, visitFilterGroups } from '@/lib/list-filters';
import { supabase } from '@/lib/supabase';
import { pageSize, usePagedList } from '@/lib/use-paged-list';
import { isVersionConflict, updateAppointment } from '@/lib/work-actions';
import { colors, font, radius, space, type Tone } from '@/theme';

type Appointment = {
  id: string;
  version: number;
  lead_id: string | null;
  phone: string | null;
  appointment_type: string;
  scheduled_at: string;
  status: string;
  attendance_status: string | null;
  notes: string | null;
  customer_name: string | null;
  interested_model: string | null;
};
type AppointmentTab = 'today' | 'upcoming' | 'completed';
const tabs: Array<{ value: AppointmentTab; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'completed', label: 'Done' },
];

function statusTone(status: string, attendance: string | null): { label: string; tone: Tone } {
  if (attendance === 'ARRIVED')
    return { label: 'Arrived', tone: { fg: colors.successStrong, bg: colors.successSoft } };
  if (status === 'CONFIRMED')
    return { label: 'Confirmed', tone: { fg: colors.warningStrong, bg: colors.warningSoft } };
  if (status === 'COMPLETED')
    return { label: 'Completed', tone: { fg: colors.successStrong, bg: colors.successSoft } };
  if (status === 'NO_SHOW' || status === 'CANCELLED')
    return {
      label: status === 'NO_SHOW' ? 'No show' : 'Cancelled',
      tone: { fg: colors.danger, bg: colors.dangerSoft },
    };
  return { label: 'Scheduled', tone: { fg: colors.primary, bg: colors.infoSoft } };
}

const dayTime = new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit' });
const dayDate = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short' });

export function MobileAppointmentsScreen({ bare }: { bare?: boolean }) {
  const [tab, setTab] = useState<AppointmentTab>('today');
  const [moving, setMoving] = useState<Appointment>();
  const [search, setSearch] = useState('');
  const filters = useFilters(visitFilterGroups);
  const { values } = filters;
  const toast = useToast();
  const { call, changed } = useCallFlow();
  // The web workspace RPC resolves the caller's scope once instead of
  // running the RLS checks on every appointment in the organization.
  const fetchPage = useCallback(
    async (page: number) => {
      const { data, error } = await supabase.rpc('get_appointment_workspace_page', {
        target_search: safeSearch(search),
        target_appointment_type: values.type,
        target_status: tab,
        target_page: page,
        target_page_size: pageSize,
        target_sort: tab === 'completed' ? 'scheduled:desc' : 'scheduled:asc',
        target_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata',
      });
      if (error || !data) throw error ?? new Error('APPOINTMENTS_UNAVAILABLE');
      const result = data as {
        records?: Appointment[] | null;
        total?: number | null;
        status_counts?: Record<string, number> | null;
      };
      return {
        records: result.records ?? [],
        total: Number(result.total ?? 0),
        counts: result.status_counts ?? undefined,
      };
    },
    [search, tab, values],
  );
  const list = usePagedList(fetchPage, { debounceMs: 300 });
  const narrowed = Boolean(search.trim()) || filters.active > 0;
  const { refresh, reload } = list;
  const mutate = useCallback(
    async (
      record: Appointment,
      patch: Parameters<typeof updateAppointment>[0]['patch'],
      message: string,
    ) => {
      try {
        await updateAppointment({ id: record.id, version: Number(record.version), patch });
        toast({ message });
        refresh();
        changed('edit');
      } catch (error) {
        toast({
          tone: 'error',
          message: isVersionConflict(error)
            ? 'Updated elsewhere, list refreshed.'
            : leadActionMessage(error, 'Could not update the visit.'),
        });
        reload();
      }
    },
    [changed, refresh, reload, toast],
  );
  const callVisit = useCallback(
    (item: Appointment) =>
      item.phone &&
      call({ leadId: item.lead_id, phone: item.phone, name: item.customer_name || 'Customer' }),
    [call],
  );
  const closed = tab === 'completed';
  const renderItem = useCallback(
    ({ item }: { item: Appointment }) => (
      <VisitRow
        item={item}
        closed={closed}
        onMutate={mutate}
        onMove={setMoving}
        onCall={callVisit}
      />
    ),
    [callVisit, closed, mutate],
  );
  return (
    <>
      <ListScreen
        bare={bare}
        title="Visits"
        toolbar={
          <>
            <FilterBar
              search={search}
              onSearch={setSearch}
              placeholder="Search name or phone"
              filters={filters}
            />
            <View style={styles.chips}>
              {tabs.map((item) => (
                <Chip
                  key={item.value}
                  label={item.label}
                  count={list.counts?.[item.value]}
                  selected={tab === item.value}
                  onPress={() => setTab(item.value)}
                />
              ))}
            </View>
          </>
        }
        data={list.items}
        keyExtractor={(record) => record.id}
        renderItem={renderItem}
        loading={list.loading}
        refreshing={list.refreshing}
        loadingMore={list.loadingMore}
        error={list.error}
        errorTitle="Visits could not load"
        emptyTitle={
          narrowed ? 'No visit matches' : tab === 'today' ? 'No visits today' : 'Nothing here yet'
        }
        emptyIcon="storefront-outline"
        onRefresh={list.refresh}
        onEndReached={list.loadMore}
        onRetry={list.reload}
      />
      {moving ? (
        <MoveSheet
          record={moving}
          onClose={() => setMoving(undefined)}
          onSave={async (when) => {
            setMoving(undefined);
            await mutate(
              moving,
              { scheduled_at: when.toISOString(), status: 'RESCHEDULED' },
              `Moved to ${formatWhen(when)}`,
            );
          }}
        />
      ) : null}
    </>
  );
}

type Mutate = (
  record: Appointment,
  patch: Parameters<typeof updateAppointment>[0]['patch'],
  message: string,
) => Promise<void>;

const VisitRow = memo(function VisitRow({
  item,
  closed,
  onMutate,
  onMove,
  onCall,
}: {
  item: Appointment;
  closed: boolean;
  onMutate: Mutate;
  onMove: (item: Appointment) => void;
  onCall: (item: Appointment) => void;
}) {
  const status = statusTone(item.status, item.attendance_status);
  const date = new Date(item.scheduled_at);
  const open = !closed && item.attendance_status !== 'ARRIVED';
  const name = item.customer_name || 'Customer';
  return (
    // Swipe right to call, the same gesture as the lead and follow-up lists.
    <SwipeRow
      left={
        item.phone
          ? { label: 'Call', icon: 'call', color: colors.success, onTrigger: () => onCall(item) }
          : undefined
      }
    >
      <RowPressable
        disabled={!item.lead_id}
        onPress={() =>
          item.lead_id && router.push({ pathname: '/lead/[id]', params: { id: item.lead_id } })
        }
        style={styles.row}
      >
        <View style={styles.time}>
          <Text style={styles.timeText}>{dayTime.format(date)}</Text>
          <Text style={styles.dateText}>{dayDate.format(date)}</Text>
        </View>
        <View style={styles.main}>
          <View style={styles.top}>
            <Text numberOfLines={1} style={styles.name}>
              {name}
            </Text>
            <Badge label={status.label} tone={status.tone} />
          </View>
          <Text numberOfLines={1} style={styles.meta}>
            {[item.appointment_type.replaceAll('_', ' ').toLowerCase(), item.interested_model]
              .filter(Boolean)
              .join(' · ')}
          </Text>
          {open ? (
            <View style={styles.actions}>
              {item.status !== 'CONFIRMED' ? (
                <TextAction
                  label="Confirm"
                  onPress={() => void onMutate(item, { status: 'CONFIRMED' }, 'Visit confirmed')}
                />
              ) : null}
              <TextAction
                label="Arrived"
                onPress={() =>
                  void onMutate(item, { attendance_status: 'ARRIVED' }, `${name} has arrived`)
                }
              />
              <TextAction label="Move" onPress={() => onMove(item)} />
            </View>
          ) : null}
        </View>
        {item.phone ? (
          <RowIcon
            icon="call"
            label={`Call ${name}`}
            color={colors.primary}
            filled
            onPress={() => onCall(item)}
          />
        ) : null}
      </RowPressable>
    </SwipeRow>
  );
});

function TextAction({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      android_ripple={{ color: colors.border }}
      style={styles.action}
    >
      <Text style={styles.actionText}>{label}</Text>
    </Pressable>
  );
}

function MoveSheet({
  record,
  onClose,
  onSave,
}: {
  record: Appointment;
  onClose: () => void;
  onSave: (when: Date) => Promise<void>;
}) {
  const [value, setValue] = useState(() => {
    const current = new Date(record.scheduled_at);
    current.setDate(current.getDate() + 1);
    return current;
  });
  const [busy, setBusy] = useState(false);
  return (
    <Sheet
      title="Move visit"
      subtitle={record.customer_name ?? undefined}
      onClose={onClose}
      footer={
        <PrimaryButton
          label="Move visit"
          icon="calendar"
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
  row: { alignItems: 'flex-start' },
  time: { width: 56, paddingTop: 1 },
  timeText: { color: colors.text, fontSize: font.row, fontWeight: '600' },
  dateText: { color: colors.faint, fontSize: font.label, marginTop: 2 },
  main: { flex: 1, minWidth: 0, gap: 2 },
  top: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  name: { flexShrink: 1, color: colors.text, fontSize: font.body, fontWeight: '600' },
  meta: { color: colors.muted, fontSize: font.small, textTransform: 'capitalize' },
  actions: { flexDirection: 'row', gap: space.sm, marginTop: space.sm },
  action: {
    paddingHorizontal: space.md,
    height: 30,
    justifyContent: 'center',
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  actionText: { color: colors.text, fontSize: font.small, fontWeight: '500' },
  grow: { flex: 1 },
});
