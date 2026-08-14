import { KpiRow, WorkCard } from '@/components/cards';
import { Screen } from '@/components/screen';
export default function Home() {
  return (
    <Screen title="Sales workspace" subtitle="Your customer schedule and priorities">
      <KpiRow
        items={[
          { label: 'Active leads', value: '28' },
          { label: 'Visits today', value: '5' },
          { label: 'Test drives', value: '3' },
          { label: 'Bookings MTD', value: '8' },
        ]}
      />
      <WorkCard title="Meera Iyer" meta="Test drive · 11:00 AM" status="UPCOMING" />
      <WorkCard title="Kabir Singh" meta="Quotation follow-up" status="DUE" />
    </Screen>
  );
}
