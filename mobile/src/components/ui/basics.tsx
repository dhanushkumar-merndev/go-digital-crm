import { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { colors, font, radius, shadow, space, type Tone } from '@/theme';
import { Icon, type IconName } from './icon';
import { PressableScale } from './pressable-scale';

export function initials(name: string) {
  return (
    name
      .split(' ')
      .filter(Boolean)
      .map((part) => part[0])
      .join('')
      .slice(0, 2)
      .toUpperCase() || '?'
  );
}

export function Badge({ label, tone }: { label: string; tone: Tone }) {
  return (
    <View style={[styles.badge, { backgroundColor: tone.bg }]}>
      <Text numberOfLines={1} style={[styles.badgeText, { color: tone.fg }]}>
        {label}
      </Text>
    </View>
  );
}

export function Avatar({ name, tone, size = 44 }: { name: string; tone: Tone; size?: number }) {
  return (
    <View
      style={[
        styles.avatar,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: tone.bg },
      ]}
    >
      <Text style={[styles.avatarText, { color: tone.fg, fontSize: size * 0.34 }]}>
        {initials(name)}
      </Text>
    </View>
  );
}

export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function SectionHeader({
  title,
  action,
  onAction,
}: {
  title: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {action && onAction ? (
        <PressableScale onPress={onAction} hitSlop={10} style={styles.sectionAction}>
          <Text style={styles.sectionActionText}>{action}</Text>
          <Icon name="chevron-forward" size={14} color={colors.primary} />
        </PressableScale>
      ) : null}
    </View>
  );
}

export function PrimaryButton({
  label,
  icon,
  onPress,
  busy,
  disabled,
  variant = 'primary',
  style,
}: {
  label: string;
  icon?: IconName;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
  variant?: 'primary' | 'secondary' | 'success' | 'danger';
  style?: ViewStyle;
}) {
  const palette = {
    primary: { bg: colors.primary, fg: colors.onColor, border: colors.primary },
    secondary: { bg: colors.card, fg: colors.text, border: colors.border },
    success: { bg: colors.whatsapp, fg: colors.onColor, border: colors.whatsapp },
    danger: { bg: colors.dangerSoft, fg: colors.danger, border: colors.dangerBorder },
  }[variant];
  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled || busy}
      style={[
        styles.button,
        { backgroundColor: palette.bg, borderColor: palette.border },
        style ?? null,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={palette.fg} />
      ) : (
        <>
          {icon ? <Icon name={icon} size={18} color={palette.fg} /> : null}
          <Text style={[styles.buttonText, { color: palette.fg }]}>{label}</Text>
        </>
      )}
    </PressableScale>
  );
}

export function IconButton({
  icon,
  onPress,
  tone,
  label,
  size = 42,
}: {
  icon: IconName;
  onPress: () => void;
  tone: Tone;
  label: string;
  size?: number;
}) {
  return (
    <PressableScale
      onPress={onPress}
      accessibilityLabel={label}
      hitSlop={6}
      scaleTo={0.88}
      style={[
        styles.iconButton,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: tone.bg },
      ]}
    >
      <Icon name={icon} size={size * 0.48} color={tone.fg} />
    </PressableScale>
  );
}

export function Chip({
  label,
  selected,
  onPress,
  count,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  count?: number;
}) {
  return (
    <PressableScale
      onPress={onPress}
      accessibilityState={{ selected }}
      style={[styles.chip, selected && styles.chipSelected]}
    >
      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{label}</Text>
      {typeof count === 'number' ? (
        <View style={[styles.chipCount, selected && styles.chipCountSelected]}>
          <Text style={[styles.chipCountText, selected && styles.chipTextSelected]}>
            {count > 999 ? '999+' : count}
          </Text>
        </View>
      ) : null}
    </PressableScale>
  );
}

function SkeletonBlock({ style }: { style: ViewStyle }) {
  const opacity = useSharedValue(0.55);
  useEffect(() => {
    opacity.value = withRepeat(withTiming(1, { duration: 700 }), -1, true);
  }, [opacity]);
  const animated = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return <Animated.View style={[styles.skeleton, style, animated]} />;
}

export function SkeletonList({ rows = 5 }: { rows?: number }) {
  return (
    <View style={styles.skeletonList}>
      {Array.from({ length: rows }, (_, index) => (
        <View key={index} style={[styles.skeletonRow, index > 0 && styles.skeletonDivider]}>
          <SkeletonBlock style={{ width: 40, height: 40, borderRadius: 20 }} />
          <View style={{ flex: 1, gap: 8 }}>
            <SkeletonBlock style={{ width: '60%', height: 14 }} />
            <SkeletonBlock style={{ width: '40%', height: 11 }} />
          </View>
        </View>
      ))}
    </View>
  );
}

export function EmptyState({
  icon = 'checkmark-done-circle-outline',
  title,
  detail,
}: {
  icon?: IconName;
  title: string;
  detail?: string;
}) {
  return (
    <View style={styles.state}>
      <View style={styles.stateIcon}>
        <Icon name={icon} size={30} color={colors.primary} />
      </View>
      <Text style={styles.stateTitle}>{title}</Text>
      {detail ? <Text style={styles.stateDetail}>{detail}</Text> : null}
    </View>
  );
}

export function ErrorState({
  title,
  detail = 'Check your connection and try again.',
  onRetry,
}: {
  title: string;
  detail?: string;
  onRetry: () => void;
}) {
  return (
    <View style={styles.state}>
      <View style={[styles.stateIcon, { backgroundColor: colors.dangerSoft }]}>
        <Icon name="cloud-offline-outline" size={28} color={colors.danger} />
      </View>
      <Text style={styles.stateTitle}>{title}</Text>
      <Text style={styles.stateDetail}>{detail}</Text>
      <PrimaryButton
        label="Try again"
        icon="refresh"
        variant="secondary"
        onPress={onRetry}
        style={{ marginTop: space.md, alignSelf: 'center', paddingHorizontal: 22 }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2, maxWidth: 150 },
  badgeText: { fontSize: font.caption, fontWeight: '600' },
  avatar: { alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontWeight: '600' },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    ...shadow,
    overflow: 'hidden',
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: space.sm,
  },
  sectionTitle: {
    color: colors.muted,
    fontSize: font.label,
    fontWeight: '600',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  sectionAction: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  sectionActionText: { color: colors.primary, fontSize: font.small, fontWeight: '600' },
  button: {
    minHeight: 48,
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: space.lg,
  },
  buttonText: { fontSize: font.body, fontWeight: '600' },
  iconButton: { alignItems: 'center', justifyContent: 'center' },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  chipSelected: { backgroundColor: colors.navy, borderColor: colors.navy },
  chipText: { color: colors.text, fontSize: font.small, fontWeight: '500' },
  chipTextSelected: { color: colors.onColor },
  chipCount: { backgroundColor: colors.subtle, borderRadius: 5, paddingHorizontal: 5 },
  chipCountSelected: { backgroundColor: '#ffffff2e' },
  chipCountText: { color: colors.muted, fontSize: font.caption, fontWeight: '600' },
  skeleton: { backgroundColor: '#e5e9f0', borderRadius: 6 },
  skeletonList: {
    backgroundColor: colors.card,
    ...shadow,
    borderLeftWidth: 0,
    borderRightWidth: 0,
  },
  skeletonRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.lg },
  skeletonDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  state: { alignItems: 'center', paddingVertical: 48, paddingHorizontal: space.xl },
  stateIcon: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.md,
  },
  stateTitle: { color: colors.text, fontSize: font.heading, fontWeight: '600', textAlign: 'center' },
  stateDetail: {
    color: colors.muted,
    fontSize: font.small,
    marginTop: 4,
    textAlign: 'center',
    lineHeight: 19,
  },
});
