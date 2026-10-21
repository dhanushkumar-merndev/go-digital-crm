import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown, FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, font, radius, space } from '@/theme';
import { Icon } from './icon';

type ToastInput = {
  message: string;
  tone?: 'success' | 'error' | 'info';
  action?: { label: string; onPress: () => void };
  durationMs?: number;
};
type ToastState = ToastInput & { id: number };

const ToastContext = createContext<(toast: ToastInput) => void>(() => undefined);

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: PropsWithChildren) {
  const insets = useSafeAreaInsets();
  const [toast, setToast] = useState<ToastState>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const counter = useRef(0);
  const show = useCallback((input: ToastInput) => {
    if (timer.current) clearTimeout(timer.current);
    const id = ++counter.current;
    setToast({ ...input, id });
    timer.current = setTimeout(
      () => setToast((current) => (current?.id === id ? undefined : current)),
      input.durationMs ?? (input.action ? 5000 : 3000),
    );
  }, []);
  const value = useMemo(() => show, [show]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      {toast ? (
        <Animated.View
          key={toast.id}
          entering={FadeInDown.duration(180)}
          exiting={FadeOut.duration(140)}
          style={[styles.wrap, { bottom: insets.bottom + 72 }]}
          pointerEvents="box-none"
        >
          {/* A plain snackbar: only an error earns an icon. */}
          <View style={styles.toast} accessibilityLiveRegion="polite">
            {toast.tone === 'error' ? <Icon name="alert-circle" size={18} color="#f87171" /> : null}
            <Text style={styles.text} numberOfLines={2}>
              {toast.message}
            </Text>
            {toast.action ? (
              <Pressable
                hitSlop={12}
                android_ripple={{ color: '#ffffff22', borderless: true }}
                onPress={() => {
                  toast.action?.onPress();
                  setToast(undefined);
                }}
              >
                <Text style={styles.action}>{toast.action.label}</Text>
              </Pressable>
            ) : null}
          </View>
        </Animated.View>
      ) : null}
    </ToastContext.Provider>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: space.lg, right: space.lg, alignItems: 'center' },
  toast: {
    width: '100%',
    maxWidth: 480,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: '#1f2937',
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    minHeight: 48,
    elevation: 6,
    shadowColor: colors.scrim,
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  text: { flex: 1, color: '#f9fafb', fontSize: font.row, fontWeight: '500', lineHeight: 20 },
  action: {
    color: '#93c5fd',
    fontSize: font.small,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
});
