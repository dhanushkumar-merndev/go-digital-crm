import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, font, radius, space } from '@/theme';
import { Icon } from './icon';
import { PressableScale } from './pressable-scale';

const dayFormat = new Intl.DateTimeFormat('en-IN', { weekday: 'short' });
const timeFormat = new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit' });
const fullFormat = new Intl.DateTimeFormat('en-IN', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
});

function at(base: Date, days: number, hours: number, minutes = 0) {
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  next.setHours(hours, minutes, 0, 0);
  return next;
}

function sameDay(left: Date, right: Date) {
  return left.toDateString() === right.toDateString();
}

export function quickTimes(now = new Date()) {
  const inAnHour = new Date(now.getTime() + 60 * 60 * 1000);
  inAnHour.setMinutes(inAnHour.getMinutes() < 30 ? 30 : 60, 0, 0);
  const evening = at(now, now.getHours() >= 18 ? 1 : 0, 18);
  const nextMonday = at(now, (8 - now.getDay()) % 7 || 7, 10);
  return [
    { label: 'In 1 hour', value: inAnHour },
    {
      label: evening.getDate() === now.getDate() ? 'This evening' : 'Tomorrow 6 PM',
      value: evening,
    },
    { label: 'Tomorrow 10 AM', value: at(now, 1, 10) },
    { label: 'Tomorrow 4 PM', value: at(now, 1, 16) },
    { label: 'In 3 days', value: at(now, 3, 10) },
    { label: 'Next Monday', value: nextMonday },
  ];
}

export function formatWhen(value: Date) {
  return fullFormat.format(value);
}

// Replaces typed "YYYY-MM-DD HH:mm" fields: the chosen time up top, one tap
// for the common choices, and a day strip plus 30-minute grid on request.
export function WhenPicker({ value, onChange }: { value: Date; onChange: (next: Date) => void }) {
  const now = useMemo(() => new Date(), []);
  const [custom, setCustom] = useState(false);
  const days = useMemo(() => Array.from({ length: 14 }, (_, index) => at(now, index, 0)), [now]);
  const slots = useMemo(() => {
    const list: Date[] = [];
    for (let minutes = 8 * 60; minutes <= 21 * 60; minutes += 30) {
      list.push(at(value, 0, Math.floor(minutes / 60), minutes % 60));
    }
    return list;
  }, [value]);
  return (
    <View style={styles.wrap}>
      <View style={styles.chosen}>
        <Icon name="calendar" size={18} color={colors.primary} />
        <Text style={styles.chosenText}>{formatWhen(value)}</Text>
      </View>
      <View style={styles.quick}>
        {quickTimes(now).map((item) => {
          const selected = item.value.getTime() === value.getTime();
          return (
            <PressableScale
              key={item.label}
              onPress={() => onChange(item.value)}
              style={[styles.quickChip, selected && styles.selected]}
            >
              <Text style={[styles.quickText, selected && styles.selectedText]}>{item.label}</Text>
            </PressableScale>
          );
        })}
        <PressableScale
          onPress={() => setCustom((open) => !open)}
          style={[styles.quickChip, custom && styles.selected]}
        >
          <Text style={[styles.quickText, custom && styles.selectedText]}>Pick a day & time</Text>
        </PressableScale>
      </View>
      {custom ? (
        <>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.days}
          >
            {days.map((day) => {
              const selected = sameDay(day, value);
              return (
                <PressableScale
                  key={day.toISOString()}
                  onPress={() => onChange(at(day, 0, value.getHours(), value.getMinutes()))}
                  style={[styles.day, selected && styles.selected]}
                >
                  <Text style={[styles.dayName, selected && styles.selectedText]}>
                    {sameDay(day, now) ? 'Today' : dayFormat.format(day)}
                  </Text>
                  <Text style={[styles.dayNumber, selected && styles.selectedText]}>
                    {day.getDate()}
                  </Text>
                </PressableScale>
              );
            })}
          </ScrollView>
          <View style={styles.slots}>
            {slots.map((slot) => {
              const past = slot.getTime() < now.getTime();
              const selected = slot.getTime() === value.getTime();
              return (
                <PressableScale
                  key={slot.toISOString()}
                  disabled={past}
                  onPress={() => onChange(slot)}
                  style={[styles.slot, selected && styles.selected]}
                >
                  <Text style={[styles.slotText, selected && styles.selectedText]}>
                    {timeFormat.format(slot)}
                  </Text>
                </PressableScale>
              );
            })}
          </View>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.md },
  quick: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  quickChip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    paddingHorizontal: 14,
    paddingVertical: 9,
    backgroundColor: colors.card,
  },
  quickText: { color: colors.text, fontSize: font.small, fontWeight: '700' },
  selected: { backgroundColor: colors.primary, borderColor: colors.primary },
  selectedText: { color: colors.onColor },
  days: { gap: space.sm },
  day: {
    width: 54,
    alignItems: 'center',
    paddingVertical: 9,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  dayName: { color: colors.muted, fontSize: font.caption, fontWeight: '700' },
  dayNumber: { color: colors.text, fontSize: font.heading, fontWeight: '600', marginTop: 2 },
  slots: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  slot: {
    width: '23%',
    alignItems: 'center',
    paddingVertical: 9,
    borderRadius: radius.sm,
    backgroundColor: '#f3f5f9',
    borderWidth: 1,
    borderColor: 'transparent',
  },
  slotText: { color: colors.text, fontSize: font.label, fontWeight: '700' },
  chosen: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: radius.md,
    backgroundColor: colors.primarySoft,
  },
  chosenText: { color: colors.primary, fontSize: font.body, fontWeight: '600' },
});
