import { useCallback, useEffect, useMemo, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Badge, Chip, EmptyState, SkeletonList } from '@/components/ui/basics';
import { dateRange, FilterBar, useFilters } from '@/components/ui/filter-sheet';
import { orNull, safeSearch, testDriveFilterGroups } from '@/lib/list-filters';
import {
  attachActiveTestDriveTracking,
  getTestDriveTrackingState,
  markDestinationReached,
  resumeTestDriveTracking,
  startTestDriveTracking,
  stopTestDriveTracking,
  type TestDriveTrackingState,
} from '@/lib/test-drive-tracking';
import { colors, font, radius, shadow, space, type Tone } from '@/theme';
import {
  loadTestDrivePage,
  saveTestDriveFeedback,
  type TestDriveFeedback,
  type TestDrivePage,
  type TestDriveRecord,
  type TestDriveView,
} from './test-drive-api';

const views: Array<{ value: TestDriveView; label: string }> = [
  { value: 'TODAY', label: 'Today' },
  { value: 'UPCOMING', label: 'Upcoming' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

type RatingKey =
  | 'drivingExperienceRating'
  | 'comfortRating'
  | 'featuresRating'
  | 'performanceRating'
  | 'pricePerceptionRating'
  | 'overallRating';

const ratingFields: Array<[RatingKey, string]> = [
  ['drivingExperienceRating', 'Drive'],
  ['comfortRating', 'Comfort'],
  ['featuresRating', 'Features'],
  ['performanceRating', 'Performance'],
  ['pricePerceptionRating', 'Price'],
  ['overallRating', 'Overall'],
];

const initialFeedback: TestDriveFeedback = {
  drivingExperienceRating: 5,
  comfortRating: 5,
  featuresRating: 5,
  performanceRating: 5,
  pricePerceptionRating: 5,
  overallRating: 5,
  comments: '',
  competitorCompared: '',
  purchaseIntent: 'INTERESTED',
};

function safeMessage(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('LOCATION_PERMISSION_REQUIRED'))
    return 'Allow precise and background location to record this route.';
  if (message.includes('BACKGROUND_LOCATION_UNAVAILABLE'))
    return 'Background route tracking requires the installed development or production app.';
  if (message.includes('ANOTHER_TEST_DRIVE_IS_ACTIVE'))
    return 'Finish the active test drive on this phone before starting another.';
  if (message.includes('TEST_DRIVE_TRACKING_NOT_ACTIVE'))
    return 'Resume GPS tracking on this phone before using this action.';
  if (message.includes('VERSION_CONFLICT'))
    return 'This test drive changed elsewhere. Refresh and try again.';
  return 'The action could not be completed. Check the connection and try again.';
}

// The Today tab also lists READY drives from earlier days, so the badge shows
// the schedule state; colours follow the schedule family in AGENTS.md 9.8.
const scheduleBadge: Record<TestDriveRecord['schedule_state'], { label: string; tone: Tone }> = {
  OVERDUE: { label: 'Overdue', tone: { fg: colors.dangerStrong, bg: colors.dangerSoft } },
  TODAY: { label: 'Today', tone: { fg: colors.primary, bg: colors.infoSoft } },
  UPCOMING: { label: 'Upcoming', tone: { fg: colors.primary, bg: colors.infoSoft } },
  ACTIVE: { label: 'Active', tone: { fg: colors.warningStrong, bg: colors.warningSoft } },
  COMPLETED: { label: 'Completed', tone: { fg: colors.successStrong, bg: colors.successSoft } },
  CANCELLED: { label: 'Cancelled', tone: { fg: colors.dangerStrong, bg: colors.dangerSoft } },
};

function formatSchedule(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Schedule unavailable';
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Kolkata',
  }).format(date);
}

function vehicleLabel(record: TestDriveRecord) {
  const catalog = [record.brand_name, record.model_name, record.variant_name]
    .filter(Boolean)
    .join(' ');
  return catalog || record.vehicle_registration || 'Assigned vehicle';
}

function PrimaryButton({
  label,
  onPress,
  disabled = false,
  tone = 'primary',
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: 'primary' | 'secondary' | 'danger';
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        tone === 'secondary' && styles.buttonSecondary,
        tone === 'danger' && styles.buttonDanger,
        (pressed || disabled) && styles.buttonMuted,
      ]}
    >
      <Text style={[styles.buttonText, tone === 'secondary' && styles.buttonSecondaryText]}>
        {label}
      </Text>
    </Pressable>
  );
}

function RatingControl({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <View style={styles.ratingRow}>
      <Text style={styles.ratingLabel}>{label}</Text>
      <View style={styles.ratingChoices}>
        {[1, 2, 3, 4, 5].map((rating) => (
          <Pressable
            accessibilityLabel={`${label} ${rating} out of 5`}
            accessibilityRole="button"
            key={rating}
            onPress={() => onChange(rating)}
            style={[styles.ratingChoice, rating === value && styles.ratingChoiceActive]}
          >
            <Text style={[styles.ratingText, rating === value && styles.ratingTextActive]}>
              {rating}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

export function TestDriveScreen({ bare }: { bare?: boolean } = {}) {
  const [view, setView] = useState<TestDriveView>('TODAY');
  const [page, setPage] = useState<TestDrivePage | null>(null);
  const [tracking, setTracking] = useState<TestDriveTrackingState | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [odometers, setOdometers] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<Record<string, TestDriveFeedback>>({});
  const [search, setSearch] = useState('');
  const [typed, setTyped] = useState('');
  const filters = useFilters(testDriveFilterGroups);
  const { values } = filters;
  // Search waits for a pause in typing, like the other lists.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(safeSearch(typed)), 300);
    return () => clearTimeout(timer);
  }, [typed]);
  const narrowed = Boolean(search) || filters.active > 0;

  const refresh = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      setError(null);
      try {
        const [nextPage, activeState] = await Promise.all([
          loadTestDrivePage(view, {
            search,
            model: orNull(values.model) ?? '',
            fromDate: dateRange(values.date).from,
            toDate: dateRange(values.date).to,
          }),
          getTestDriveTrackingState(),
        ]);
        setPage(nextPage);
        setTracking(activeState);
      } catch (caught) {
        setError(safeMessage(caught));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [search, values, view],
  );

  useFocusEffect(
    useCallback(() => {
      let active = true;
      void resumeTestDriveTracking()
        .catch(() => null)
        .finally(() => {
          if (active) void refresh();
        });
      return () => {
        active = false;
      };
    }, [refresh]),
  );

  const kpis = useMemo(
    () => [
      { label: 'Today', value: String(page?.kpis.today ?? 0) },
      { label: 'Overdue', value: String(page?.kpis.overdue ?? 0) },
      { label: 'Active', value: String(page?.kpis.active ?? 0) },
      { label: 'Completed MTD', value: String(page?.kpis.completed_this_month ?? 0) },
    ],
    [page],
  );

  const run = useCallback(
    async (recordId: string, action: () => Promise<unknown>) => {
      setBusyId(recordId);
      setError(null);
      try {
        await action();
        await refresh(true);
      } catch (caught) {
        setError(safeMessage(caught));
        setTracking(await getTestDriveTrackingState());
      } finally {
        setBusyId(null);
      }
    },
    [refresh],
  );

  const numericOdometer = (record: TestDriveRecord) => {
    const parsed = Number(odometers[record.id]);
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= 2_000_000 ? parsed : null;
  };

  const updateFeedback = <K extends keyof TestDriveFeedback>(
    recordId: string,
    key: K,
    value: TestDriveFeedback[K],
  ) => {
    setFeedback((current) => ({
      ...current,
      [recordId]: { ...(current[recordId] ?? initialFeedback), [key]: value },
    }));
  };

  const Wrapper = bare ? View : SafeAreaView;
  return (
    <Wrapper style={styles.safe}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void refresh(true);
            }}
          />
        }
      >
        {bare ? null : <Text style={styles.title}>Test drives</Text>}

        <StatStrip items={kpis} />

        <FilterBar
          search={typed}
          onSearch={setTyped}
          placeholder="Search customer or vehicle"
          filters={filters}
        />

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.tabs}
        >
          {views.map((item) => (
            <Chip
              key={item.value}
              label={item.label}
              selected={view === item.value}
              onPress={() => setView(item.value)}
            />
          ))}
        </ScrollView>

        {tracking ? (
          <View style={styles.notice}>
            <Text style={styles.noticeTitle}>GPS recovery ready</Text>
            <Text style={styles.noticeText}>
              {tracking.phase === 'ACTIVE'
                ? 'This phone is securely buffering the active route.'
                : 'An interrupted route action is saved and can be retried without duplicating it.'}
            </Text>
            {tracking.phase !== 'ACTIVE' ? (
              <PrimaryButton
                label="Resume saved action"
                onPress={() => void run(tracking.testDriveId, resumeTestDriveTracking)}
                disabled={busyId === tracking.testDriveId}
              />
            ) : null}
          </View>
        ) : null}

        {error ? (
          <View accessibilityRole="alert" style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
            <PrimaryButton label="Retry" tone="secondary" onPress={() => void refresh()} />
          </View>
        ) : null}

        {loading ? <SkeletonList rows={3} /> : null}
        {!loading && page?.records.length === 0 ? (
          <EmptyState
            icon="car-sport-outline"
            title={narrowed ? 'No test drive matches' : 'No test drives here'}
            detail={
              narrowed
                ? 'Try fewer filters or another tab.'
                : 'Pull down to refresh after a schedule changes.'
            }
          />
        ) : null}

        {page?.records.map((record) => {
          const isBusy = busyId === record.id;
          const local = tracking?.testDriveId === record.id ? tracking : null;
          const odometer = numericOdometer(record);
          const draft = feedback[record.id] ?? initialFeedback;
          return (
            <View key={record.id} style={styles.card}>
              <View style={styles.cardHeader}>
                <View style={styles.cardMain}>
                  <Text style={styles.customer}>{record.customer_name}</Text>
                  <Text style={styles.vehicle}>{vehicleLabel(record)}</Text>
                </View>
                <Badge
                  label={scheduleBadge[record.schedule_state]?.label ?? record.status}
                  tone={
                    scheduleBadge[record.schedule_state]?.tone ?? {
                      fg: colors.primary,
                      bg: colors.infoSoft,
                    }
                  }
                />
              </View>
              <Text style={styles.meta}>{formatSchedule(record.scheduled_at)}</Text>
              <Text style={styles.meta}>
                {record.branch_name}
                {record.team_name ? ` · ${record.team_name}` : ''}
              </Text>
              {record.vehicle_registration || record.vin ? (
                <Text style={styles.meta}>
                  {[record.vehicle_registration, record.vin].filter(Boolean).join(' · ')}
                </Text>
              ) : null}

              {record.status === 'READY' ? (
                <View style={styles.actionPanel}>
                  <Text style={styles.fieldLabel}>Starting odometer (km)</Text>
                  <TextInput
                    keyboardType="number-pad"
                    onChangeText={(value) =>
                      setOdometers((current) => ({ ...current, [record.id]: value }))
                    }
                    placeholder="e.g. 12540"
                    placeholderTextColor={colors.faint}
                    style={styles.input}
                    value={odometers[record.id] ?? ''}
                  />
                  <PrimaryButton
                    disabled={isBusy || odometer === null || Boolean(tracking)}
                    label={isBusy ? 'Starting…' : 'Start GPS test drive'}
                    onPress={() =>
                      void run(record.id, () =>
                        startTestDriveTracking(record.id, record.version, odometer!),
                      )
                    }
                  />
                </View>
              ) : null}

              {record.status === 'ACTIVE' ? (
                <View style={styles.actionPanel}>
                  {!local ? (
                    <PrimaryButton
                      disabled={isBusy || Boolean(tracking)}
                      label="Resume GPS on this phone"
                      onPress={() =>
                        void run(record.id, () =>
                          attachActiveTestDriveTracking(record.id, record.version),
                        )
                      }
                    />
                  ) : (
                    <>
                      {!record.reached_at && !local.destinationReached ? (
                        <PrimaryButton
                          disabled={isBusy || local.phase !== 'ACTIVE'}
                          label="Mark destination reached"
                          tone="secondary"
                          onPress={() =>
                            void run(record.id, () => markDestinationReached(record.id))
                          }
                        />
                      ) : null}
                      <Text style={styles.fieldLabel}>Ending odometer (km)</Text>
                      <TextInput
                        keyboardType="number-pad"
                        onChangeText={(value) =>
                          setOdometers((current) => ({ ...current, [record.id]: value }))
                        }
                        placeholder={`At least ${record.start_odometer ?? 0}`}
                        placeholderTextColor={colors.faint}
                        style={styles.input}
                        value={odometers[record.id] ?? ''}
                      />
                      <PrimaryButton
                        disabled={
                          isBusy ||
                          local.phase !== 'ACTIVE' ||
                          odometer === null ||
                          odometer < (record.start_odometer ?? 0)
                        }
                        label={isBusy ? 'Saving route…' : 'End and upload route'}
                        onPress={() =>
                          void run(record.id, () => stopTestDriveTracking(record.id, odometer!))
                        }
                      />
                    </>
                  )}
                </View>
              ) : null}

              {record.status === 'COMPLETED' && record.gps_status === 'ROUTE_UPLOAD_PENDING' ? (
                <View style={styles.actionPanel}>
                  <Text style={styles.warningText}>
                    Route upload is pending. Complete it on the phone that recorded the drive.
                  </Text>
                  {local ? (
                    <PrimaryButton
                      disabled={isBusy}
                      label={isBusy ? 'Uploading…' : 'Retry saved route upload'}
                      onPress={() => void run(record.id, resumeTestDriveTracking)}
                    />
                  ) : null}
                </View>
              ) : null}

              {record.status === 'COMPLETED' && record.gps_status === 'ROUTE_FINALIZED' ? (
                record.feedback_id ? (
                  <View style={styles.feedbackSummary}>
                    <Text style={styles.feedbackTitle}>Feedback saved</Text>
                    <Text style={styles.meta}>
                      {record.overall_rating ?? '–'}/5 ·{' '}
                      {(record.purchase_intent ?? '').replaceAll('_', ' ')}
                    </Text>
                  </View>
                ) : (
                  <View style={styles.actionPanel}>
                    <Text style={styles.feedbackTitle}>Customer feedback</Text>
                    {ratingFields.map(([key, label]) => (
                      <RatingControl
                        key={key}
                        label={label}
                        value={draft[key] as number}
                        onChange={(value) => updateFeedback(record.id, key, value)}
                      />
                    ))}
                    <Text style={styles.fieldLabel}>Purchase intent</Text>
                    <View style={styles.intentChoices}>
                      {(
                        [
                          'HIGHLY_INTERESTED',
                          'INTERESTED',
                          'CONSIDERING',
                          'NOT_INTERESTED',
                        ] as const
                      ).map((intent) => (
                        <Pressable
                          accessibilityRole="button"
                          key={intent}
                          onPress={() => updateFeedback(record.id, 'purchaseIntent', intent)}
                          style={[
                            styles.intentChoice,
                            draft.purchaseIntent === intent && styles.intentChoiceActive,
                          ]}
                        >
                          <Text
                            style={[
                              styles.intentText,
                              draft.purchaseIntent === intent && styles.intentTextActive,
                            ]}
                          >
                            {intent.replaceAll('_', ' ')}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                    <TextInput
                      maxLength={160}
                      onChangeText={(value) =>
                        updateFeedback(record.id, 'competitorCompared', value)
                      }
                      placeholder="Competitor compared (optional)"
                      placeholderTextColor={colors.faint}
                      style={styles.input}
                      value={draft.competitorCompared}
                    />
                    <TextInput
                      maxLength={2000}
                      multiline
                      onChangeText={(value) => updateFeedback(record.id, 'comments', value)}
                      placeholder="Customer comments (optional)"
                      placeholderTextColor={colors.faint}
                      style={[styles.input, styles.textarea]}
                      value={draft.comments}
                    />
                    <PrimaryButton
                      disabled={isBusy}
                      label={isBusy ? 'Saving…' : 'Save feedback'}
                      onPress={() =>
                        void run(record.id, () =>
                          saveTestDriveFeedback(record.id, record.version, draft),
                        )
                      }
                    />
                  </View>
                )
              ) : null}
            </View>
          );
        })}
      </ScrollView>
    </Wrapper>
  );
}

function StatStrip({ items }: { items: Array<{ label: string; value: string }> }) {
  return (
    <View style={styles.stats}>
      {items.map((item, index) => (
        <View key={item.label} style={[styles.stat, index > 0 && styles.statDivider]}>
          <Text style={styles.statValue}>{item.value}</Text>
          <Text style={styles.statLabel} numberOfLines={1}>
            {item.label}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  content: { padding: space.lg, paddingTop: space.sm, paddingBottom: 40, gap: space.md },
  title: { color: colors.text, fontSize: font.hero, fontWeight: '700', letterSpacing: -0.5 },
  stats: {
    flexDirection: 'row',
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    paddingVertical: space.md,
    ...shadow,
  },
  stat: { flex: 1, alignItems: 'center', gap: 2 },
  statDivider: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.border },
  statValue: { color: colors.text, fontSize: font.large, fontWeight: '700' },
  statLabel: { color: colors.muted, fontSize: font.caption, fontWeight: '700' },
  tabs: { gap: 8 },
  notice: {
    backgroundColor: colors.infoSoft,
    borderColor: colors.infoBorderStrong,
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    gap: 8,
  },
  noticeTitle: { color: '#1e3a8a', fontWeight: '600', fontSize: font.small },
  noticeText: { color: '#1e40af', fontSize: font.label, lineHeight: 17 },
  errorBox: {
    backgroundColor: colors.dangerSoft,
    borderColor: colors.dangerBorder,
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    gap: 10,
  },
  errorText: { color: colors.danger, fontSize: font.label, lineHeight: 17 },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: space.lg,
    gap: 6,
    ...shadow,
  },
  cardHeader: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  cardMain: { flex: 1 },
  customer: { color: colors.text, fontSize: font.heading, fontWeight: '600' },
  vehicle: { color: colors.text, fontSize: font.label, fontWeight: '600', marginTop: 3 },
  meta: { color: colors.muted, fontSize: font.caption, lineHeight: 16 },
  actionPanel: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    marginTop: 8,
    paddingTop: 12,
    gap: 10,
  },
  fieldLabel: { color: colors.text, fontSize: font.caption, fontWeight: '700' },
  input: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    backgroundColor: colors.onColor,
    color: colors.text,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: font.small,
  },
  textarea: { minHeight: 86, textAlignVertical: 'top' },
  button: {
    minHeight: 44,
    borderRadius: 10,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 13,
  },
  buttonSecondary: { backgroundColor: colors.onColor, borderColor: colors.primary, borderWidth: 1 },
  buttonDanger: { backgroundColor: colors.danger },
  buttonMuted: { opacity: 0.55 },
  buttonText: { color: colors.onColor, fontSize: font.label, fontWeight: '600' },
  buttonSecondaryText: { color: colors.primary },
  warningText: { color: colors.warning, fontSize: font.label, lineHeight: 17 },
  feedbackSummary: {
    backgroundColor: colors.successSoft,
    borderRadius: 10,
    padding: 12,
    marginTop: 8,
  },
  feedbackTitle: { color: colors.text, fontSize: font.small, fontWeight: '600' },
  ratingRow: { gap: 5 },
  ratingLabel: { color: colors.muted, fontSize: font.caption, fontWeight: '700' },
  ratingChoices: { flexDirection: 'row', gap: 7 },
  ratingChoice: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ratingChoiceActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  ratingText: { color: colors.muted, fontSize: font.caption, fontWeight: '700' },
  ratingTextActive: { color: colors.onColor },
  intentChoices: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  intentChoice: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 18,
    paddingHorizontal: 9,
    paddingVertical: 7,
  },
  intentChoiceActive: { backgroundColor: colors.infoBorder, borderColor: colors.primary },
  intentText: { color: colors.muted, fontSize: font.caption, fontWeight: '700' },
  intentTextActive: { color: colors.primary },
});
