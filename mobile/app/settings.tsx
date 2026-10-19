import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { Screen } from '@/components/screen';
import {
  fetchCallAiPreferences,
  saveCallAiPreferences,
  type CallAiPreferences,
} from '@/lib/call-ai';
import {
  forgetRecordingFolder,
  getRecordingFolder,
  recordingFolderSupported,
  setCachedAutoSync,
  type RecordingFolder,
} from '@/lib/recording-sync';
import { supabase } from '@/lib/supabase';
import { colors } from '@/theme';

export default function Settings() {
  const [preferences, setPreferences] = useState<CallAiPreferences | null>(null);
  const [folder, setFolder] = useState<RecordingFolder | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(undefined);
    const [{ data }, chosen] = await Promise.all([
      supabase.auth.getSession(),
      getRecordingFolder(),
    ]);
    setEmail(data.session?.user.email ?? null);
    setFolder(chosen);
    try {
      const saved = await fetchCallAiPreferences();
      setPreferences(saved);
      await setCachedAutoSync(saved.auto_sync);
    } catch {
      setError('Settings could not load. Check your connection.');
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const update = async (change: Partial<CallAiPreferences>) => {
    if (!preferences) return;
    const previous = preferences;
    setPreferences({ ...preferences, ...change });
    setSaving(true);
    setError(undefined);
    try {
      const saved = await saveCallAiPreferences(change);
      setPreferences(saved);
      await setCachedAutoSync(saved.auto_sync);
    } catch {
      setPreferences(previous);
      setError('The setting was not saved. Try again.');
    } finally {
      setSaving(false);
    }
  };

  const toggleAutoProcess = (value: boolean) => {
    if (!value) {
      void update({ auto_process: false });
      return;
    }
    Alert.alert(
      'Transcribe every recording?',
      'Each recording you sync will be transcribed and summarised automatically. This uses the dealership’s AI credits for every call.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Turn on', onPress: () => void update({ auto_process: true }) },
      ],
    );
  };

  const signOut = async () => {
    await supabase.auth.signOut({ scope: 'local' });
    router.replace('/');
  };

  return (
    <Screen
      title="Settings"
      subtitle={email ?? 'Your account'}
      action={
        <Pressable onPress={() => router.back()}>
          <Text style={styles.back}>Back</Text>
        </Pressable>
      }
    >
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Call recordings</Text>
        {!preferences && !error ? <ActivityIndicator color={colors.primary} /> : null}
        {preferences ? (
          <>
            <Setting
              label="Sync recordings automatically"
              detail={
                recordingFolderSupported()
                  ? 'When the app opens, and in the background when the phone allows.'
                  : 'Folder sync is available on Android.'
              }
              value={preferences.auto_sync}
              disabled={saving}
              onChange={(value) => void update({ auto_sync: value })}
            />
            <Setting
              label="Transcribe & summarise automatically"
              detail="Off: tap Transcribe & summarise on the calls you need, to save AI credits."
              value={preferences.auto_process}
              disabled={saving}
              onChange={toggleAutoProcess}
            />
          </>
        ) : null}
        {recordingFolderSupported() ? (
          <View style={styles.folder}>
            <View style={styles.folderMain}>
              <Text style={styles.label}>Recorder folder</Text>
              <Text style={styles.value}>{folder?.name ?? 'Not chosen'}</Text>
            </View>
            <Pressable onPress={() => router.push('/recordings')}>
              <Text style={styles.link}>{folder ? 'Open' : 'Choose'}</Text>
            </Pressable>
          </View>
        ) : null}
        {folder ? (
          <Pressable
            onPress={() => {
              void forgetRecordingFolder().then(() => setFolder(null));
            }}
          >
            <Text style={styles.danger}>Stop watching this folder</Text>
          </Pressable>
        ) : null}
        {error ? (
          <Pressable onPress={() => void load()}>
            <Text style={styles.error}>{error} Tap to retry.</Text>
          </Pressable>
        ) : null}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Account</Text>
        <Text style={styles.value}>{email ?? '—'}</Text>
        <Pressable style={styles.signOut} onPress={() => void signOut()}>
          <Text style={styles.signOutText}>Sign out</Text>
        </Pressable>
      </View>
    </Screen>
  );
}

function Setting({
  label,
  detail,
  value,
  disabled,
  onChange,
}: {
  label: string;
  detail: string;
  value: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <View style={styles.setting}>
      <View style={styles.settingMain}>
        <Text style={styles.settingLabel}>{label}</Text>
        <Text style={styles.settingDetail}>{detail}</Text>
      </View>
      <Switch value={value} onValueChange={onChange} disabled={disabled} />
    </View>
  );
}

const styles = StyleSheet.create({
  back: { color: colors.primary, fontWeight: '700' },
  card: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 16,
    padding: 15,
    gap: 12,
  },
  cardTitle: { color: colors.navy, fontSize: 16, fontWeight: '800' },
  setting: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  settingMain: { flex: 1 },
  settingLabel: { color: colors.text, fontSize: 14, fontWeight: '700' },
  settingDetail: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 2 },
  folder: {
    flexDirection: 'row',
    alignItems: 'center',
    borderTopColor: colors.border,
    borderTopWidth: 1,
    paddingTop: 12,
  },
  folderMain: { flex: 1 },
  label: { color: colors.muted, fontSize: 11, fontWeight: '700' },
  value: { color: colors.text, fontSize: 14, fontWeight: '700', marginTop: 2 },
  link: { color: colors.primary, fontWeight: '800' },
  danger: { color: colors.danger, fontSize: 12, fontWeight: '700' },
  error: { color: colors.danger, fontSize: 12 },
  signOut: {
    borderWidth: 1,
    borderColor: colors.danger,
    borderRadius: 11,
    padding: 12,
    alignItems: 'center',
  },
  signOutText: { color: colors.danger, fontWeight: '800' },
});
