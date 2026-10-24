import { router, useLocalSearchParams } from 'expo-router';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { ListScreen } from '@/components/screen';
import { Avatar, Badge, Card, Chip, PrimaryButton } from '@/components/ui/basics';
import { Icon, type IconName } from '@/components/ui/icon';
import { RowPressable } from '@/components/ui/row';
import { useCallFlow } from '@/features/call-flow/call-flow';
import { openWhatsApp } from '@/lib/contact';
import {
  customer360TabAllowed,
  customer360Tabs,
  fetchCustomer360,
  fetchCustomer360Section,
  fetchLeadJourney,
  leadScopedSections,
  type Customer360Core,
  type Customer360Page,
  type Customer360Row,
  type Customer360Section,
  type Customer360Tab,
} from '@/lib/customer-detail';
import { colors, font, radius, space, stageTone, temperatureTone, type Tone } from '@/theme';

const when = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

function dateText(value: unknown) {
  if (typeof value !== 'string' || !value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : when.format(date);
}

function humanize(value: unknown) {
  if (typeof value !== 'string' || !value) return '';
  return value
    .replaceAll('_', ' ')
    .toLowerCase()
    .replace(/^\w/, (character) => character.toUpperCase());
}

function rupees(value: unknown) {
  const amount = typeof value === 'number' ? value : Number(value);
  if (value === null || value === undefined || !Number.isFinite(amount)) return null;
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(amount);
}

function text(value: unknown) {
  return typeof value === 'string' && value ? value : null;
}

const neutral: Tone = { fg: '#4b5563', bg: '#f3f4f6' };

function statusTone(status: unknown): Tone {
  const value = String(status ?? '');
  if (/COMPLETED|CONFIRMED|DELIVERED|APPROVED|ACCEPTED|CONNECTED|ARRIVED/.test(value))
    return { fg: colors.successStrong, bg: colors.successSoft };
  if (/OVERDUE|CANCELLED|REJECTED|NO_SHOW|FAILED|EXPIRED/.test(value))
    return { fg: '#be123c', bg: '#fff1f2' };
  if (/OPEN|SCHEDULED|PENDING|SENT|ACTIVE|DRAFT/.test(value))
    return { fg: colors.warningStrong, bg: colors.warningSoft };
  return neutral;
}

type Line = {
  key: string;
  icon: IconName;
  title: string;
  meta: string;
  body?: string | null;
  badge?: { label: string; tone: Tone } | null;
  onPress?: () => void;
};

function openLead(leadId: unknown) {
  return typeof leadId === 'string'
    ? () => router.push({ pathname: '/lead/[id]', params: { id: leadId } })
    : undefined;
}

// One row shape for every tab, so each section is a few lines of mapping.
function toLine(section: Customer360Section | 'journey', row: Customer360Row): Line {
  const join = (...parts: Array<string | null | undefined>) => parts.filter(Boolean).join(' · ');
  switch (section) {
    case 'leads':
      return {
        key: row.id,
        icon: 'person-outline',
        title: text(row.interested_model) ?? 'Enquiry',
        meta: join(text(row.source), dateText(row.created_at), text(row.assigned_user_name)),
        badge: {
          label: String(row.lifecycle_status ?? ''),
          tone: stageTone(text(row.lifecycle_status)),
        },
        onPress: openLead(row.id),
      };
    case 'calls': {
      const seconds = typeof row.duration_seconds === 'number' ? row.duration_seconds : null;
      return {
        key: row.id,
        icon: 'call-outline',
        title: humanize(row.outcome ?? row.status) || 'Call',
        meta: join(
          dateText(row.started_at),
          seconds === null ? null : `${Math.floor(seconds / 60)}m ${seconds % 60}s`,
          text(row.assigned_user_name),
        ),
        body: text(row.ai_summary),
        onPress: () => router.push({ pathname: '/call/[id]', params: { id: row.id } }),
      };
    }
    case 'followups':
      return {
        key: row.id,
        icon: 'alarm-outline',
        title: text(row.reason) ?? 'Follow-up',
        meta: join(dateText(row.due_at), text(row.assigned_user_name)),
        badge: { label: humanize(row.status), tone: statusTone(row.status) },
        onPress: openLead(row.lead_id),
      };
    case 'appointments':
      return {
        key: row.id,
        icon: 'storefront-outline',
        title: text(row.appointment_type) ?? 'Visit',
        meta: join(dateText(row.scheduled_at), text(row.branch_name), text(row.assigned_user_name)),
        badge: {
          label: humanize(row.attendance_status ?? row.status),
          tone: statusTone(row.attendance_status ?? row.status),
        },
        onPress: openLead(row.lead_id),
      };
    case 'test_drives': {
      const meters = typeof row.distance_meters === 'number' ? row.distance_meters : null;
      return {
        key: row.id,
        icon: 'car-sport-outline',
        title: 'Test drive',
        meta: join(
          dateText(row.completed_at ?? row.started_at),
          meters === null ? null : `${(meters / 1000).toFixed(1)} km`,
          text(row.assigned_user_name),
        ),
        badge: { label: humanize(row.status), tone: statusTone(row.status) },
        onPress: openLead(row.lead_id),
      };
    }
    case 'quotations':
      return {
        key: row.id,
        icon: 'document-text-outline',
        title: text(row.quotation_number) ?? 'Quotation',
        meta: join(
          rupees(row.total_amount),
          `v${String(row.current_version ?? 1)}`,
          dateText(row.updated_at),
        ),
        badge: { label: humanize(row.status), tone: statusTone(row.status) },
        onPress: openLead(row.lead_id),
      };
    case 'bookings':
      return {
        key: row.id,
        icon: 'receipt-outline',
        title: text(row.booking_number) ?? 'Booking',
        meta: join(
          rupees(row.booking_amount) ? `Paid ${rupees(row.booking_amount)}` : null,
          row.expected_delivery_date ? `Delivery ${dateText(row.expected_delivery_date)}` : null,
        ),
        badge: { label: humanize(row.status), tone: statusTone(row.status) },
        onPress: openLead(row.lead_id),
      };
    case 'vehicles':
      return {
        key: row.id,
        icon: 'car-outline',
        title:
          join(text(row.brand), text(row.model), text(row.variant)).replaceAll(' · ', ' ') ||
          'Vehicle',
        meta: join(
          text(row.registration),
          row.model_year ? String(row.model_year) : null,
          text(row.fuel_type),
          typeof row.odometer_km === 'number'
            ? `${row.odometer_km.toLocaleString('en-IN')} km`
            : null,
        ),
      };
    case 'timeline':
      return {
        key: row.id,
        icon: 'time-outline',
        title: humanize(row.activity_type) || 'Activity',
        meta: join(text(row.actor_name), dateText(row.occurred_at)),
        onPress: openLead(row.lead_id),
      };
    case 'journey':
      return {
        // One record can produce several events (a visit booked, then completed).
        key: `${String(row.kind)}:${row.id}:${String(row.occurred_at)}`,
        icon: 'git-commit-outline',
        title: text(row.title) ?? humanize(row.kind),
        meta: join(text(row.actor_name), dateText(row.occurred_at)),
        body: text(row.detail),
      };
  }
}

const LineRow = memo(function LineRow({ line }: { line: Line }) {
  return (
    <RowPressable disabled={!line.onPress} onPress={line.onPress}>
      <View style={styles.lineIcon}>
        <Icon name={line.icon} size={18} color={colors.primary} />
      </View>
      <View style={styles.grow}>
        <View style={styles.lineTop}>
          <Text numberOfLines={1} style={styles.lineTitle}>
            {line.title}
          </Text>
          {line.badge?.label ? <Badge label={line.badge.label} tone={line.badge.tone} /> : null}
        </View>
        {line.meta ? (
          <Text numberOfLines={1} style={styles.lineMeta}>
            {line.meta}
          </Text>
        ) : null}
        {line.body ? (
          <Text numberOfLines={3} style={styles.lineBody}>
            {line.body}
          </Text>
        ) : null}
      </View>
      {line.onPress ? <Icon name="chevron-forward" size={18} color={colors.faint} /> : null}
    </RowPressable>
  );
});

type Item = { kind: 'line'; line: Line } | { kind: 'block'; key: string; node: React.ReactNode };

function renderItem({ item }: { item: Item }) {
  return item.kind === 'line' ? <LineRow line={item.line} /> : <>{item.node}</>;
}

// Pages one tab: page numbers for most sections, a keyset cursor for the
// customer timeline and the lead journey. A tab or lead change starts over and
// drops any response still in flight.
function useSection(core: Customer360Core | undefined, tab: Customer360Tab, leadId: string | null) {
  const [lines, setLines] = useState<Line[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const state = useRef({ page: 1, cursor: null as Customer360Page['nextCursor'], hasMore: false });
  const sequence = useRef(0);
  const journey = tab === 'timeline' && Boolean(leadId);
  const fetchPage = useCallback(
    async (page: number, cursor: Customer360Page['nextCursor']) => {
      if (!core || tab === 'overview') return null;
      if (journey && leadId) {
        const result = await fetchLeadJourney(leadId, cursor);
        return {
          lines: result.events.map((event) =>
            toLine('journey', event as unknown as Customer360Row),
          ),
          total: undefined,
          hasMore: Boolean(result.nextCursor),
          nextCursor: result.nextCursor,
        };
      }
      const result = await fetchCustomer360Section({ core, section: tab, page, leadId, cursor });
      return {
        lines: result.records.map((record) => toLine(tab, record)),
        total: result.total,
        hasMore: result.hasMore,
        nextCursor: result.nextCursor,
      };
    },
    [core, journey, leadId, tab],
  );
  const load = useCallback(async () => {
    const request = ++sequence.current;
    setLoading(true);
    setError(false);
    try {
      const result = await fetchPage(1, null);
      if (request !== sequence.current) return;
      setLines(result?.lines ?? []);
      setTotal(result?.total ?? result?.lines.length ?? 0);
      state.current = {
        page: 1,
        cursor: result?.nextCursor ?? null,
        hasMore: Boolean(result?.hasMore),
      };
    } catch {
      if (request === sequence.current) setError(true);
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  }, [fetchPage]);
  useEffect(() => {
    void load();
  }, [load]);
  const loadMore = useCallback(async () => {
    if (loading || loadingMore || !state.current.hasMore) return;
    const request = sequence.current;
    setLoadingMore(true);
    try {
      const next = state.current.page + 1;
      const result = await fetchPage(next, state.current.cursor);
      if (request !== sequence.current || !result) return;
      setLines((current) => {
        const seen = new Set(current.map((line) => line.key));
        return [...current, ...result.lines.filter((line) => !seen.has(line.key))];
      });
      if (result.total !== undefined) setTotal(result.total);
      state.current = { page: next, cursor: result.nextCursor, hasMore: result.hasMore };
    } catch {
      // The next scroll retries.
    } finally {
      setLoadingMore(false);
    }
  }, [fetchPage, loading, loadingMore]);
  return { lines, total, loading, loadingMore, error, reload: load, loadMore, journey };
}

export default function CustomerDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { call } = useCallFlow();
  const [core, setCore] = useState<Customer360Core>();
  const [coreError, setCoreError] = useState(false);
  const [tab, setTab] = useState<Customer360Tab>('overview');
  const [leadId, setLeadId] = useState<string | null>(null);
  const loadCore = useCallback(async () => {
    if (!id) return;
    setCoreError(false);
    try {
      const next = await fetchCustomer360(id);
      setCore(next);
      // One enquiry: its journey is the timeline, so there is nothing to pick.
      if (next.leadOptions.length === 1) setLeadId(next.leadOptions[0].id);
    } catch {
      setCoreError(true);
    }
  }, [id]);
  useEffect(() => {
    void loadCore();
  }, [loadCore]);
  const section = useSection(core, tab, leadId);

  if (!core) {
    return (
      <ListScreen
        back
        title="Customer"
        data={[] as Item[]}
        renderItem={renderItem}
        keyExtractor={() => 'empty'}
        loading={!coreError}
        error={coreError}
        errorTitle="This customer could not load"
        emptyTitle="Customer unavailable"
        onRefresh={() => void loadCore()}
        onRetry={() => void loadCore()}
      />
    );
  }

  const { customer, opportunity } = core;
  const phone = customer.primary_phone;
  const tabs = customer360Tabs.filter((item) => customer360TabAllowed(core, item.key));
  const showPicker =
    tab !== 'overview' && leadScopedSections.has(tab) && core.leadOptions.length > 1;
  const items: Item[] =
    tab === 'overview'
      ? overviewBlocks(core)
      : section.lines.map((line) => ({ kind: 'line', line }));
  return (
    <ListScreen
      back
      title={customer.full_name}
      subtitle={[opportunity?.branch_name, opportunity?.team_name].filter(Boolean).join(' · ')}
      toolbar={
        <>
          <Card style={styles.header}>
            <View style={styles.headerRow}>
              <Avatar
                name={customer.full_name}
                tone={{ fg: colors.primary, bg: colors.primarySoft }}
                size={48}
              />
              <View style={styles.grow}>
                <Text style={styles.phone}>{phone ?? 'No phone on file'}</Text>
                <View style={styles.badges}>
                  {opportunity ? (
                    <Badge
                      label={opportunity.lifecycle_status}
                      tone={stageTone(opportunity.lifecycle_status)}
                    />
                  ) : null}
                  {opportunity?.temperature ? (
                    <Badge
                      label={opportunity.temperature}
                      tone={temperatureTone(opportunity.temperature)}
                    />
                  ) : null}
                  <Text numberOfLines={1} style={styles.owner}>
                    {opportunity?.assigned_user_name ?? ''}
                  </Text>
                </View>
              </View>
            </View>
            {phone ? (
              <View style={styles.actions}>
                <PrimaryButton
                  label="Call"
                  icon="call"
                  style={styles.grow}
                  onPress={() =>
                    call({ leadId: opportunity?.id ?? null, phone, name: customer.full_name })
                  }
                />
                <PrimaryButton
                  label="WhatsApp"
                  icon="logo-whatsapp"
                  variant="success"
                  style={styles.grow}
                  onPress={() => void openWhatsApp(customer.whatsapp_phone ?? phone)}
                />
              </View>
            ) : null}
          </Card>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chips}
          >
            {tabs.map((item) => (
              <Chip
                key={item.key}
                label={item.label}
                selected={tab === item.key}
                onPress={() => setTab(item.key)}
              />
            ))}
          </ScrollView>
          {showPicker ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.chips}
            >
              <Chip
                label="All enquiries"
                selected={leadId === null}
                onPress={() => setLeadId(null)}
              />
              {core.leadOptions.map((lead) => (
                <Chip
                  key={lead.id}
                  label={[lead.interested_model ?? 'Enquiry', lead.source].join(' · ')}
                  selected={leadId === lead.id}
                  onPress={() => setLeadId(lead.id)}
                />
              ))}
            </ScrollView>
          ) : null}
        </>
      }
      data={items}
      cards={tab === 'overview'}
      keyExtractor={(item) => (item.kind === 'line' ? item.line.key : item.key)}
      renderItem={renderItem}
      loading={tab !== 'overview' && section.loading}
      loadingMore={section.loadingMore}
      error={tab !== 'overview' && section.error}
      errorTitle="This section could not load"
      emptyTitle={
        tab === 'timeline' && section.journey
          ? 'No activity on this enquiry yet'
          : `No ${tabs.find((item) => item.key === tab)?.label.toLowerCase() ?? 'records'} yet`
      }
      emptyIcon="file-tray-outline"
      onRefresh={() => (tab === 'overview' ? void loadCore() : void section.reload())}
      onEndReached={() => void section.loadMore()}
      onRetry={() => void section.reload()}
    />
  );
}

function Fact({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <View style={styles.fact}>
      <Text style={styles.factLabel}>{label}</Text>
      <Text style={styles.factValue}>{value}</Text>
    </View>
  );
}

function yesNo(value: boolean | null | undefined) {
  return value === true ? 'Yes' : value === false ? 'No' : null;
}

function overviewBlocks(core: Customer360Core): Item[] {
  const { opportunity, customer } = core;
  const requirements = opportunity?.requirements ?? null;
  const blocks: Item[] = [];
  if (opportunity) {
    blocks.push({
      kind: 'block',
      key: 'opportunity',
      node: (
        <Card style={styles.block}>
          <Text style={styles.blockTitle}>Current enquiry</Text>
          <Fact label="Interested in" value={opportunity.interested_model ?? 'Not specified'} />
          <Fact
            label="Source"
            value={[opportunity.source, opportunity.campaign].filter(Boolean).join(' · ')}
          />
          <Fact label="Owner" value={opportunity.assigned_user_name ?? 'Unassigned'} />
          <Fact label="Variant" value={requirements?.variant} />
          <Fact
            label="Budget"
            value={requirements?.budget_max ? `Up to ${rupees(requirements.budget_max)}` : null}
          />
          <Fact label="Buying timeline" value={requirements?.purchase_timeline} />
          <Fact label="Needs finance" value={yesNo(requirements?.finance_required)} />
          <Fact label="Has exchange" value={yesNo(requirements?.exchange_required)} />
          <Fact label="Wants test drive" value={yesNo(requirements?.test_drive_required)} />
          <Fact label="Also considering" value={requirements?.competitors?.join(', ')} />
          <PrimaryButton
            label="Open lead"
            icon="open-outline"
            variant="secondary"
            onPress={() => router.push({ pathname: '/lead/[id]', params: { id: opportunity.id } })}
          />
        </Card>
      ),
    });
    const summary = opportunity.latest_call_summary;
    if (summary)
      blocks.push({
        kind: 'block',
        key: 'summary',
        node: (
          <Card style={styles.block}>
            <Text style={styles.blockTitle}>Last call summary</Text>
            <Text style={styles.lineMeta}>
              {[summary.caller_name, dateText(summary.started_at)].filter(Boolean).join(' · ')}
            </Text>
            <Text style={styles.summary}>{summary.summary}</Text>
          </Card>
        ),
      });
  }
  // The primary phone, WhatsApp and email are usually also contact rows; list
  // each number or address once.
  const contactKey = (value: string) =>
    value.includes('@') ? value.trim().toLowerCase() : value.replace(/\D/g, '').slice(-10);
  const shown = new Set(
    [customer.primary_phone, customer.whatsapp_phone, customer.primary_email]
      .filter((value): value is string => Boolean(value))
      .map(contactKey),
  );
  const contacts = core.contacts.filter(
    (contact) => contact.value && !shown.has(contactKey(contact.value)),
  );
  blocks.push({
    kind: 'block',
    key: 'contact',
    node: (
      <Card style={styles.block}>
        <Text style={styles.blockTitle}>Contact</Text>
        <Fact label="Phone" value={customer.primary_phone} />
        <Fact label="WhatsApp" value={customer.whatsapp_phone ?? null} />
        <Fact label="Email" value={customer.primary_email} />
        {contacts.map((contact) => (
          <Fact key={contact.id} label={humanize(contact.type)} value={contact.value} />
        ))}
        {/* Counts only enquiries this user can open; after a transfer that can be
            none, which would read as a customer with no enquiries. */}
        <Fact
          label="Enquiries"
          value={core.leadOptions.length ? String(core.leadOptions.length) : null}
        />
      </Card>
    ),
  });
  if (core.notes.length)
    blocks.push({
      kind: 'block',
      key: 'notes',
      node: (
        <Card style={styles.block}>
          <Text style={styles.blockTitle}>Notes</Text>
          {core.notes.slice(0, 5).map((note) => (
            <View key={note.id} style={styles.note}>
              <Text style={styles.summary}>{note.body}</Text>
              <Text style={styles.lineMeta}>
                {[note.created_by_name, dateText(note.created_at)].filter(Boolean).join(' · ')}
              </Text>
            </View>
          ))}
        </Card>
      ),
    });
  return blocks;
}

const styles = StyleSheet.create({
  grow: { flex: 1 },
  header: { gap: space.md, padding: space.md },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  phone: { color: colors.text, fontSize: font.body, fontWeight: '600' },
  badges: { flexDirection: 'row', alignItems: 'center', gap: space.xs, marginTop: 4 },
  owner: { flexShrink: 1, color: colors.muted, fontSize: font.small },
  actions: { flexDirection: 'row', gap: space.sm },
  chips: { gap: space.sm },
  lineIcon: {
    width: 36,
    height: 36,
    borderRadius: radius.pill,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lineTop: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  lineTitle: { flexShrink: 1, color: colors.text, fontSize: font.body, fontWeight: '600' },
  lineMeta: { color: colors.muted, fontSize: font.small, marginTop: 2 },
  lineBody: { color: colors.text, fontSize: font.small, marginTop: 4, lineHeight: 18 },
  block: { gap: space.sm, padding: space.md },
  blockTitle: { color: colors.text, fontSize: font.heading, fontWeight: '700' },
  fact: { flexDirection: 'row', justifyContent: 'space-between', gap: space.md },
  factLabel: { color: colors.muted, fontSize: font.small },
  factValue: {
    flexShrink: 1,
    color: colors.text,
    fontSize: font.small,
    fontWeight: '600',
    textAlign: 'right',
  },
  summary: { color: colors.text, fontSize: font.small, lineHeight: 19 },
  note: { gap: 2, paddingVertical: space.xs },
});
