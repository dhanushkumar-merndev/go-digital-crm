import { useCallback, useEffect, type ReactNode } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import {
  GestureDetector,
  GestureHandlerRootView,
  usePanGesture,
} from 'react-native-gesture-handler';
import Animated, {
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';
import { gentle } from '@/motion/springs';
import { colors, font, radius, space } from '@/theme';

// A bottom sheet that springs up, follows the finger when dragged by its
// handle, and dismisses past a third of its height or on a downward fling.
export function Sheet({
  title,
  subtitle,
  onClose,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const offset = useSharedValue(height);
  useEffect(() => {
    offset.value = withSpring(0, gentle);
  }, [offset]);
  const close = useCallback(() => {
    offset.value = withTiming(height, { duration: 200 }, (finished) => {
      if (finished) scheduleOnRN(onClose);
    });
  }, [height, offset, onClose]);
  const drag = usePanGesture({
    onUpdate: (event) => {
      offset.value = Math.max(0, event.translationY);
    },
    onDeactivate: (event) => {
      if (event.translationY > height * 0.25 || event.velocityY > 900) {
        offset.value = withTiming(height, { duration: 180 }, (finished) => {
          if (finished) scheduleOnRN(onClose);
        });
      } else {
        offset.value = withSpring(0, gentle);
      }
    },
  });
  const panel = useAnimatedStyle(() => ({ transform: [{ translateY: offset.value }] }));
  const backdrop = useAnimatedStyle(() => ({
    opacity: interpolate(offset.value, [0, height * 0.6], [1, 0], 'clamp'),
  }));
  return (
    <Modal visible transparent statusBarTranslucent animationType="none" onRequestClose={close}>
      <GestureHandlerRootView style={styles.root}>
        <Animated.View style={[styles.backdrop, backdrop]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={close} accessibilityLabel="Close" />
        </Animated.View>
        <KeyboardAvoidingView behavior="padding" style={styles.avoid} pointerEvents="box-none">
          <Animated.View
            style={[
              styles.panel,
              { maxHeight: height * 0.9, paddingBottom: insets.bottom + space.md },
              panel,
            ]}
          >
            <GestureDetector gesture={drag}>
              <View style={styles.grab}>
                <View style={styles.handle} />
                <Text style={styles.title}>{title}</Text>
                {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
              </View>
            </GestureDetector>
            <ScrollView
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.body}
              bounces={false}
            >
              {children}
            </ScrollView>
            {footer ? <View style={styles.footer}>{footer}</View> : null}
          </Animated.View>
        </KeyboardAvoidingView>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  backdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: '#0f172a73',
  },
  avoid: { flex: 1, justifyContent: 'flex-end' },
  panel: {
    backgroundColor: colors.card,
    borderTopLeftRadius: radius.lg + 6,
    borderTopRightRadius: radius.lg + 6,
  },
  grab: { paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.sm },
  handle: {
    alignSelf: 'center',
    width: 40,
    height: 5,
    borderRadius: 3,
    backgroundColor: '#d6dbe3',
    marginBottom: space.md,
  },
  title: { color: colors.text, fontSize: font.large, fontWeight: '700' },
  subtitle: { color: colors.muted, fontSize: font.small, marginTop: 3 },
  body: { paddingHorizontal: space.lg, paddingBottom: space.md, gap: space.md },
  footer: { flexDirection: 'row', gap: space.sm, paddingHorizontal: space.lg },
});
