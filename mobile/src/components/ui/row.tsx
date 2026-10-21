import type { PropsWithChildren } from 'react';
import { Pressable, StyleSheet, View, type PressableProps, type ViewStyle } from 'react-native';
import { colors, space } from '@/theme';
import { Icon, type IconName } from './icon';

// List rows press with the platform ripple rather than an animated scale: a
// list holds dozens of them, and a native ripple costs nothing per row.
export function RowPressable({
  children,
  style,
  ...props
}: PropsWithChildren<Omit<PressableProps, 'style'> & { style?: ViewStyle | ViewStyle[] }>) {
  return (
    <Pressable
      android_ripple={{ color: colors.pressed }}
      accessibilityRole="button"
      {...props}
      style={({ pressed }) => [styles.row, style, pressed && styles.pressed]}
    >
      {children}
    </Pressable>
  );
}

// A quiet round icon action inside a row. `filled` marks the one primary action.
export function RowIcon({
  icon,
  label,
  onPress,
  color = colors.muted,
  filled,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  color?: string;
  filled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      onPress={onPress}
      android_ripple={{ color: filled ? '#ffffff33' : colors.border, borderless: !filled }}
      style={[styles.icon, filled && { backgroundColor: color }]}
    >
      <Icon name={icon} size={18} color={filled ? colors.onColor : color} />
    </Pressable>
  );
}

export function RowIcons({ children }: PropsWithChildren) {
  return <View style={styles.icons}>{children}</View>;
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    backgroundColor: colors.card,
  },
  pressed: { backgroundColor: colors.pressed },
  icon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  icons: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
});
