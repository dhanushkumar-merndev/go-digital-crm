import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from '@/theme';

export function KpiRow({ items }: { items: Array<{ label: string; value: string }> }) {
  return (
    <View style={styles.kpiRow}>
      {items.map((item) => (
        <View key={item.label} style={styles.kpi}>
          <Text style={styles.kpiLabel}>{item.label}</Text>
          <Text style={styles.kpiValue}>{item.value}</Text>
        </View>
      ))}
    </View>
  );
}

export function WorkCard({
  title,
  meta,
  status,
  onPress,
}: {
  title: string;
  meta: string;
  status: string;
  onPress?: () => void;
}) {
  return (
    <Pressable style={styles.card} onPress={onPress}>
      <View style={styles.avatar}>
        <Text style={styles.avatarText}>
          {title
            .split(' ')
            .map((part) => part[0])
            .join('')
            .slice(0, 2)}
        </Text>
      </View>
      <View style={styles.main}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.meta}>{meta}</Text>
      </View>
      <View style={styles.badge}>
        <Text style={styles.badgeText}>{status}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  kpiRow: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  kpi: {
    width: '48%',
    minWidth: 135,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: 14,
  },
  kpiLabel: { color: colors.muted, fontSize: 11, fontWeight: '600' },
  kpiValue: { color: colors.text, fontSize: 22, fontWeight: '800', marginTop: 6 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: 13,
    gap: 11,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#dbeafe',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: '#1d4ed8', fontWeight: '800', fontSize: 12 },
  main: { flex: 1 },
  title: { color: colors.text, fontSize: 14, fontWeight: '700' },
  meta: { color: colors.muted, fontSize: 11, marginTop: 4 },
  badge: { paddingVertical: 4, paddingHorizontal: 8, borderRadius: 20, backgroundColor: '#fff7ed' },
  badgeText: { color: colors.warning, fontSize: 9, fontWeight: '800' },
});
