import type { BottomTabBarProps, BottomTabNavigationOptions } from 'expo-router/tabs';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { Icon, type IconName } from '@/components/ui/icon';
import { tick } from '@/motion/haptics';
import { glide, settle, snappy } from '@/motion/springs';
import { colors, font } from '@/theme';

export type TabSpec = { name: string; label: string; icon: IconName; activeIcon: IconName };

// Shared by both role layouts. A short cross-fade over the app background:
// 'shift' slid an empty scene in first, which let the window show through.
export const tabScreenOptions: BottomTabNavigationOptions = {
  headerShown: false,
  animation: 'fade',
  transitionSpec: { animation: 'timing', config: { duration: 140 } },
  lazy: false,
  freezeOnBlur: true,
  sceneStyle: { backgroundColor: colors.background },
};

const PILL_WIDTH = 60;
const PILL_HEIGHT = 32;

// Custom bar: the active pill springs straight to the tapped tab.
export function SquishyTabBar({
  state,
  navigation,
  insets,
  tabs,
}: BottomTabBarProps & { tabs: TabSpec[] }) {
  const [width, setWidth] = useState(0);
  const reduceMotion = useReducedMotion();
  const activeName = state.routes[state.index]?.name;
  const activeIndex = Math.max(
    0,
    tabs.findIndex((tab) => tab.name === activeName),
  );
  const slot = width / tabs.length;
  const x = useSharedValue(0);
  useEffect(() => {
    if (!slot) return;
    const target = activeIndex * slot + (slot - PILL_WIDTH) / 2;
    if (reduceMotion) {
      x.value = target;
      return;
    }
    x.value = withSpring(target, glide);
  }, [activeIndex, reduceMotion, slot, x]);
  const pill = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  return (
    <View
      style={[styles.bar, { paddingBottom: Math.max(insets.bottom, 8) }]}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      {width ? <Animated.View style={[styles.pill, pill]} /> : null}
      {tabs.map((tab, index) => {
        const route = state.routes.find((item) => item.name === tab.name);
        if (!route) return null;
        const focused = index === activeIndex;
        return (
          <TabButton
            key={tab.name}
            tab={tab}
            focused={focused}
            onPress={() => {
              const event = navigation.emit({
                type: 'tabPress',
                target: route.key,
                canPreventDefault: true,
              });
              if (!focused && !event.defaultPrevented) {
                tick();
                navigation.navigate(route.name, route.params);
              }
            }}
          />
        );
      })}
    </View>
  );
}

function TabButton({
  tab,
  focused,
  onPress,
}: {
  tab: TabSpec;
  focused: boolean;
  onPress: () => void;
}) {
  const scale = useSharedValue(1);
  const lift = useSharedValue(focused ? 1 : 0);
  useEffect(() => {
    lift.value = withSpring(focused ? 1 : 0, snappy);
    if (focused)
      scale.value = withSequence(withTiming(1.08, { duration: 110 }), withSpring(1, settle));
  }, [focused, lift, scale]);
  const icon = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const label = useAnimatedStyle(() => ({ opacity: 0.6 + lift.value * 0.4 }));
  return (
    <Pressable
      onPress={onPress}
      style={styles.tab}
      accessibilityRole="tab"
      accessibilityState={{ selected: focused }}
      accessibilityLabel={tab.label}
    >
      <Animated.View style={[styles.iconWrap, icon]}>
        <Icon
          name={focused ? tab.activeIcon : tab.icon}
          size={22}
          color={focused ? colors.primary : colors.muted}
        />
      </Animated.View>
      <Animated.Text
        style={[styles.label, { color: focused ? colors.primary : colors.muted }, label]}
        numberOfLines={1}
      >
        {tab.label}
      </Animated.Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    backgroundColor: colors.card,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: 8,
  },
  pill: {
    position: 'absolute',
    top: 8,
    left: 0,
    width: PILL_WIDTH,
    height: PILL_HEIGHT,
    borderRadius: PILL_HEIGHT / 2,
    backgroundColor: colors.primarySoft,
  },
  tab: { flex: 1, alignItems: 'center', gap: 4 },
  iconWrap: { height: PILL_HEIGHT, justifyContent: 'center' },
  label: { fontSize: font.caption, fontWeight: '600' },
});
