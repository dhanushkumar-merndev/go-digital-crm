import type { PropsWithChildren } from 'react';
import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { snappy } from '@/motion/springs';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

// Every tappable surface shrinks slightly under the finger and springs back.
export function PressableScale({
  children,
  style,
  scaleTo = 0.96,
  ...props
}: PropsWithChildren<
  Omit<PressableProps, 'style'> & { style?: StyleProp<ViewStyle>; scaleTo?: number }
>) {
  const scale = useSharedValue(1);
  const animated = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return (
    <AnimatedPressable
      accessibilityRole="button"
      {...props}
      onPressIn={(event) => {
        scale.value = withSpring(scaleTo, snappy);
        props.onPressIn?.(event);
      }}
      onPressOut={(event) => {
        scale.value = withSpring(1, snappy);
        props.onPressOut?.(event);
      }}
      style={[style, animated, props.disabled ? { opacity: 0.45 } : null]}
    >
      {children}
    </AnimatedPressable>
  );
}
