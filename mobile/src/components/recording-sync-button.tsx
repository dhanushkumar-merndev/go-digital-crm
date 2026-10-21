import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Icon } from '@/components/ui/icon';
import { PressableScale } from '@/components/ui/pressable-scale';
import { useToast } from '@/components/ui/toast';
import {
  getRecordingFolder,
  initializeRecordingLedger,
  onRecordingSyncFinished,
  recordingCounts,
  recordingFolderSupported,
  syncRecordings,
} from '@/lib/recording-sync';
import { supabase } from '@/lib/supabase';
import { colors } from '@/theme';

// One tap syncs call recordings without opening More → Call recordings. The
// badge counts files still to send or waiting for a number; with no folder
// chosen yet the tap opens Call recordings to choose one.
export function RecordingSyncButton() {
  const toast = useToast();
  const [waiting, setWaiting] = useState(0);
  const [busy, setBusy] = useState(false);
  const recount = useCallback(async () => {
    if (!recordingFolderSupported()) return;
    const { data } = await supabase.auth.getSession();
    const userId = data.session?.user.id;
    if (!userId) return;
    initializeRecordingLedger();
    const counts = recordingCounts(userId);
    setWaiting((counts.PENDING ?? 0) + (counts.FAILED ?? 0) + (counts.NEEDS_NUMBER ?? 0));
  }, []);
  useFocusEffect(
    useCallback(() => {
      void recount();
    }, [recount]),
  );
  // Auto sync (app open, foreground, background task) also updates the badge.
  useEffect(() => onRecordingSyncFinished(() => void recount()), [recount]);
  if (!recordingFolderSupported()) return null;
  const sync = async () => {
    if (!(await getRecordingFolder())) {
      router.push('/recordings');
      return;
    }
    setBusy(true);
    try {
      const result = await syncRecordings();
      toast({
        tone: result.failed ? 'error' : 'success',
        message: result.failed
          ? `${result.failed} recording${result.failed > 1 ? 's' : ''} could not sync`
          : result.synced
            ? `${result.synced} recording${result.synced > 1 ? 's' : ''} synced`
            : 'Recordings are up to date',
      });
    } catch {
      toast({ tone: 'error', message: 'Sync could not run. Check your connection.' });
    } finally {
      setBusy(false);
      void recount();
    }
  };
  return (
    <PressableScale
      onPress={() => void sync()}
      onLongPress={() => router.push('/recordings')}
      disabled={busy}
      scaleTo={0.9}
      style={styles.button}
      accessibilityRole="button"
      accessibilityLabel={waiting ? `Sync recordings, ${waiting} waiting` : 'Sync recordings'}
    >
      {busy ? (
        <ActivityIndicator size="small" color={colors.primary} />
      ) : (
        <Icon name="sync" size={20} color={colors.primary} />
      )}
      {waiting && !busy ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{waiting > 99 ? '99+' : waiting}</Text>
        </View>
      ) : null}
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  button: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    top: -4,
    right: -4,
    minWidth: 20,
    height: 20,
    paddingHorizontal: 5,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.warning,
    borderWidth: 2,
    borderColor: colors.background,
  },
  badgeText: { color: colors.onColor, fontSize: 11, fontWeight: '700' },
});
