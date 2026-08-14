import { router } from 'expo-router';
import { KpiRow, WorkCard } from './cards';
import { Screen } from './screen';

const people = ['Aarav Sharma', 'Diya Patel', 'Kabir Singh', 'Meera Iyer', 'Vihaan Rao'];

export function WorkListScreen({
  title,
  subtitle = 'Your authorized customer work queue',
}: {
  title: string;
  subtitle?: string;
}) {
  return (
    <Screen title={title} subtitle={subtitle}>
      <KpiRow
        items={[
          { label: 'Due today', value: '18' },
          { label: 'Needs attention', value: '6' },
        ]}
      />
      {people.map((name, index) => (
        <WorkCard
          key={name}
          title={name}
          meta={`Nexon EV · ${index + 8}:${index % 2 ? '30' : '00'} AM`}
          status={index % 3 === 0 ? 'SLA RISK' : 'PENDING'}
          onPress={() => router.push('/lead/GDM-1024')}
        />
      ))}
    </Screen>
  );
}
