import { useRef, type ReactNode } from 'react';
import { colors, font } from '@/theme';
import { StyleSheet, Text, View } from 'react-native';
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from 'react-native-gesture-handler/ReanimatedSwipeable';
import Animated, { interpolate, useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { Icon, type IconName } from '@/components/ui/icon';
import { tick } from '@/motion/haptics';

export type SwipeAction = { label: string; icon: IconName; color: string; onTrigger: () => void };

function Reveal({
  action,
  progress,
  align,
}: {
  action: SwipeAction;
  progress: SharedValue<number>;
  align: 'left' | 'right';
}) {
  const animated = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.4, 1], [0, 0.8, 1], 'clamp'),
    transform: [{ scale: interpolate(progress.value, [0, 1], [0.6, 1], 'clamp') }],
  }));
  return (
    <View
      style={[
        styles.reveal,
        { backgroundColor: action.color, alignItems: align === 'left' ? 'flex-start' : 'flex-end' },
      ]}
    >
      <Animated.View style={[styles.revealInner, animated]}>
        <Icon name={action.icon} size={24} color="#fff" />
        <Text style={styles.revealText}>{action.label}</Text>
      </Animated.View>
    </View>
  );
}

// Swipe right for the left action (Call), left for the right action (Done).
// Releasing past the threshold triggers it and the row springs back.
export function SwipeRow({
  children,
  left,
  right,
}: {
  children: ReactNode;
  left?: SwipeAction;
  right?: SwipeAction;
}) {
  const ref = useRef<SwipeableMethods>(null);
  return (
    <ReanimatedSwipeable
      ref={ref}
      friction={1}
      leftThreshold={84}
      rightThreshold={84}
      overshootLeft={false}
      overshootRight={false}
      containerStyle={styles.container}
      renderLeftActions={
        left ? (progress) => <Reveal action={left} progress={progress} align="left" /> : undefined
      }
      renderRightActions={
        right
          ? (progress) => <Reveal action={right} progress={progress} align="right" />
          : undefined
      }
      onSwipeableWillOpen={(direction) => {
        tick();
        ref.current?.close();
        // The direction is where the row moves: moving right reveals the left action.
        const action = direction === 'right' ? left : right;
        action?.onTrigger();
      }}
    >
      {children}
    </ReanimatedSwipeable>
  );
}

const styles = StyleSheet.create({
  container: { overflow: 'hidden' },
  reveal: { flex: 1, justifyContent: 'center', paddingHorizontal: 24, minWidth: 110 },
  revealInner: { alignItems: 'center', gap: 4 },
  revealText: { color: colors.onColor, fontSize: font.label, fontWeight: '600' },
});
