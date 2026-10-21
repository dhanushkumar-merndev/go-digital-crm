import { router } from 'expo-router';
import type { PropsWithChildren, ReactElement, ReactNode } from 'react';
import {
  ActivityIndicator,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ListRenderItem,
} from 'react-native';
import Animated, { LayoutAnimationConfig } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';
import { EmptyState, ErrorState, SkeletonList } from '@/components/ui/basics';
import { Icon, type IconName } from '@/components/ui/icon';
import { PressableScale } from '@/components/ui/pressable-scale';
import { colors, font, space } from '@/theme';

type HeaderProps = { title: string; subtitle?: string; action?: ReactNode; back?: boolean };

function Header({ title, subtitle, action, back }: HeaderProps) {
  return (
    <View style={[styles.header, back && styles.headerCompact]}>
      {back ? (
        <PressableScale
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
          accessibilityLabel="Back"
          hitSlop={12}
          scaleTo={0.85}
          style={styles.back}
        >
          <Icon name="chevron-back" size={24} color={colors.text} />
        </PressableScale>
      ) : null}
      <View style={styles.heading}>
        <Text numberOfLines={1} style={back ? styles.titleCompact : styles.title}>
          {title}
        </Text>
        {subtitle ? (
          <Text numberOfLines={1} style={styles.subtitle}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {action ? <View>{action}</View> : null}
    </View>
  );
}

export function Screen({
  children,
  footer,
  refreshing,
  onRefresh,
  ...header
}: PropsWithChildren<
  HeaderProps & { footer?: ReactNode; refreshing?: boolean; onRefresh?: () => void }
>) {
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <Header {...header} />
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          onRefresh ? (
            <RefreshControl
              refreshing={Boolean(refreshing)}
              onRefresh={onRefresh}
              colors={[colors.primary]}
            />
          ) : undefined
        }
      >
        {children}
      </ScrollView>
      {footer ? <View style={styles.footer}>{footer}</View> : null}
    </SafeAreaView>
  );
}

// Paged lists: pull to refresh, load more at the end, and rows that slide
// into place when one is removed.
export function ListScreen<T>({
  data,
  renderItem,
  keyExtractor,
  toolbar,
  listHeader,
  loading,
  refreshing,
  loadingMore,
  error,
  errorTitle = 'This list could not load',
  emptyTitle,
  emptyDetail,
  emptyIcon,
  onRefresh,
  onEndReached,
  onRetry,
  bare,
  ...header
}: HeaderProps & {
  // Rendered inside another screen (Sales Schedule) that owns the header.
  bare?: boolean;
  data: T[];
  renderItem: ListRenderItem<T>;
  keyExtractor: (item: T) => string;
  toolbar?: ReactNode;
  listHeader?: ReactElement;
  loading: boolean;
  refreshing?: boolean;
  loadingMore?: boolean;
  error: boolean;
  errorTitle?: string;
  emptyTitle: string;
  emptyDetail?: string;
  emptyIcon?: IconName;
  onRefresh: () => void;
  onEndReached?: () => void;
  onRetry: () => void;
}) {
  const body = (
    <>
      {toolbar ? <View style={styles.toolbar}>{toolbar}</View> : null}
      {/* A new filter or tab swaps the list for skeletons; skipping exits keeps
          every old row from playing its "done" slide-out at once. */}
      {loading ? (
        <View style={styles.listContent}>
          <SkeletonList />
        </View>
      ) : (
        <LayoutAnimationConfig skipExiting>
          <Animated.FlatList
            data={error ? [] : data}
            renderItem={renderItem}
            keyExtractor={keyExtractor}
            contentContainerStyle={styles.listContent}
            ItemSeparatorComponent={Separator}
            ListHeaderComponent={listHeader}
            ListEmptyComponent={
              error ? (
                <ErrorState title={errorTitle} onRetry={onRetry} />
              ) : (
                <EmptyState title={emptyTitle} detail={emptyDetail} icon={emptyIcon} />
              )
            }
            ListFooterComponent={
              loadingMore ? <ActivityIndicator color={colors.primary} style={styles.more} /> : null
            }
            // Render a screenful first and keep a short window mounted, so a
            // long list stays light while it scrolls.
            initialNumToRender={10}
            maxToRenderPerBatch={8}
            updateCellsBatchingPeriod={50}
            windowSize={7}
            removeClippedSubviews={Platform.OS === 'android'}
            onEndReachedThreshold={0.4}
            onEndReached={onEndReached}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            refreshControl={
              <RefreshControl
                refreshing={Boolean(refreshing)}
                onRefresh={onRefresh}
                colors={[colors.primary]}
              />
            }
          />
        </LayoutAnimationConfig>
      )}
    </>
  );
  if (bare) return <View style={styles.bare}>{body}</View>;
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <Header {...header} />
      {body}
    </SafeAreaView>
  );
}

// Rows share one flat surface; the divider starts after the avatar column.
function Separator() {
  return (
    <View style={styles.separator}>
      <View style={styles.separatorLine} />
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  bare: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.sm,
  },
  headerCompact: { paddingHorizontal: space.sm, paddingTop: space.sm },
  back: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  heading: { flex: 1 },
  title: { color: colors.text, fontSize: font.hero, fontWeight: '700', letterSpacing: -0.4 },
  titleCompact: { color: colors.text, fontSize: font.title, fontWeight: '700' },
  subtitle: { color: colors.muted, fontSize: font.small, fontWeight: '500', marginTop: 2 },
  content: { padding: space.lg, paddingTop: space.sm, paddingBottom: 40, gap: space.md },
  toolbar: { paddingHorizontal: space.lg, paddingBottom: space.sm, gap: space.sm },
  listContent: { paddingBottom: 40, flexGrow: 1 },
  separator: { backgroundColor: colors.card },
  separatorLine: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginLeft: space.lg,
  },
  more: { paddingVertical: space.lg },
  footer: {
    flexDirection: 'row',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    paddingBottom: space.lg,
    backgroundColor: colors.card,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
});
