import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MobileAppointmentsScreen } from '@/components/mobile-appointments-screen';
import { MobileWorkQueueScreen } from '@/components/mobile-work-queue-screen';
import { TestDriveScreen } from '@/features/test-drives/test-drive-screen';
import { tick } from '@/motion/haptics';
import { glide } from '@/motion/springs';
import { colors, font, radius, shadow, space } from '@/theme';

type Segment = 'followups' | 'visits' | 'drives';
const segments: Array<{ value: Segment; label: string }> = [
  { value: 'followups', label: 'Follow-ups' },
  { value: 'visits', label: 'Visits' },
  { value: 'drives', label: 'Test drives' },
];

// Follow-ups, showroom visits and test drives in one tab. Each segment mounts
// on first visit and stays mounted, so switching back keeps its scroll and tab.
export default function Schedule() {
  const params = useLocalSearchParams<{ view?: string }>();
  const initial = segments.some((item) => item.value === params.view)
    ? (params.view as Segment)
    : 'followups';
  const [active, setActive] = useState<Segment>(initial);
  const [mounted, setMounted] = useState<Set<Segment>>(() => new Set([initial]));
  const [width, setWidth] = useState(0);
  const x = useSharedValue(0);
  const index = segments.findIndex((item) => item.value === active);
  const slot = width / segments.length;
  useEffect(() => {
    if (params.view && segments.some((item) => item.value === params.view)) {
      const next = params.view as Segment;
      setActive(next);
      setMounted((current) => new Set(current).add(next));
    }
  }, [params.view]);
  useEffect(() => {
    if (slot) x.value = withSpring(index * slot, glide);
  }, [index, slot, x]);
  const indicator = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  const select = (value: Segment) => {
    if (value === active) return;
    tick();
    setActive(value);
    setMounted((current) => new Set(current).add(value));
  };
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <Text style={styles.title}>Schedule</Text>
      <View
        style={styles.segments}
        onLayout={(event) => setWidth(event.nativeEvent.layout.width - 8)}
      >
        {width ? <Animated.View style={[styles.indicator, { width: slot }, indicator]} /> : null}
        {segments.map((item) => {
          const selected = item.value === active;
          return (
            <Pressable
              key={item.value}
              onPress={() => select(item.value)}
              style={styles.segment}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
            >
              <Text style={[styles.segmentText, selected && styles.segmentTextActive]}>
                {item.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <View style={styles.body}>
        {mounted.has('followups') ? (
          <View style={[styles.pane, active !== 'followups' && styles.hidden]}>
            <MobileWorkQueueScreen kind="followups" bare />
          </View>
        ) : null}
        {mounted.has('visits') ? (
          <View style={[styles.pane, active !== 'visits' && styles.hidden]}>
            <MobileAppointmentsScreen bare />
          </View>
        ) : null}
        {mounted.has('drives') ? (
          <View style={[styles.pane, active !== 'drives' && styles.hidden]}>
            <TestDriveScreen bare />
          </View>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  title: {
    color: colors.text,
    fontSize: font.hero,
    fontWeight: '600',
    letterSpacing: -0.5,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
  },
  segments: {
    flexDirection: 'row',
    margin: space.lg,
    marginTop: space.md,
    marginBottom: space.sm,
    padding: 4,
    borderRadius: radius.md,
    backgroundColor: '#e9edf3',
  },
  indicator: {
    position: 'absolute',
    top: 4,
    bottom: 4,
    left: 4,
    borderRadius: radius.sm,
    backgroundColor: colors.card,
    ...shadow,
  },
  segment: { flex: 1, alignItems: 'center', paddingVertical: 9 },
  segmentText: { color: colors.muted, fontSize: font.small, fontWeight: '600' },
  segmentTextActive: { color: colors.text },
  body: { flex: 1 },
  pane: { flex: 1 },
  hidden: { display: 'none' },
});
