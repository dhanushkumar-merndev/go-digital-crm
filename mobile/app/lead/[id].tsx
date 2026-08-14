import { router, useLocalSearchParams } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Screen } from '@/components/screen';
import { colors } from '@/theme';
export default function LeadDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <Screen
      title="Aarav Sharma"
      subtitle={`Lead ${id}`}
      action={
        <Pressable onPress={() => router.back()}>
          <Text style={styles.back}>Back</Text>
        </Pressable>
      }
    >
      <View style={styles.card}>
        <Text style={styles.label}>CONTACT</Text>
        <Text style={styles.value}>+91 98731 00001</Text>
        <Text style={styles.label}>INTERESTED VEHICLE</Text>
        <Text style={styles.value}>Nexon EV · Empowered+ LR</Text>
        <Text style={styles.label}>NEXT FOLLOW-UP</Text>
        <Text style={styles.value}>15 Aug 2026 · 11:30 AM</Text>
      </View>
      <Pressable style={styles.primary}>
        <Text style={styles.primaryText}>Call customer</Text>
      </Pressable>
      <Pressable style={styles.secondary}>
        <Text style={styles.secondaryText}>Schedule follow-up</Text>
      </Pressable>
    </Screen>
  );
}
const styles = StyleSheet.create({
  back: { color: colors.primary, fontWeight: '700' },
  card: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: 'white',
    borderRadius: 14,
    padding: 16,
  },
  label: { color: colors.muted, fontSize: 10, fontWeight: '800', marginTop: 12 },
  value: { color: colors.text, fontSize: 14, fontWeight: '700', marginTop: 4 },
  primary: { backgroundColor: colors.primary, padding: 15, borderRadius: 12, alignItems: 'center' },
  primaryText: { color: 'white', fontWeight: '800' },
  secondary: {
    backgroundColor: 'white',
    borderWidth: 1,
    borderColor: colors.border,
    padding: 15,
    borderRadius: 12,
    alignItems: 'center',
  },
  secondaryText: { color: colors.text, fontWeight: '800' },
});
