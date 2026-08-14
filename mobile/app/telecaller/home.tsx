import { KpiRow, WorkCard } from '@/components/cards';
import { Screen } from '@/components/screen';
export default function Home() {
  return (
    <Screen title="Good morning, Priya" subtitle="Here is what needs attention today">
      <KpiRow
        items={[
          { label: 'New leads', value: '12' },
          { label: 'Follow-ups', value: '18' },
          { label: 'Calls made', value: '26' },
          { label: 'SLA risk', value: '4' },
        ]}
      />
      <WorkCard title="Aarav Sharma" meta="Follow-up · 10:30 AM" status="DUE NOW" />
      <WorkCard title="Diya Patel" meta="New lead · Website" status="NEW" />
    </Screen>
  );
}
