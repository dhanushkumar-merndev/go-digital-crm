import { router, Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { AppState, StyleSheet, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { ToastProvider } from '@/components/ui/toast';
import { CallFlowProvider } from '@/features/call-flow/call-flow';
import { autoSyncRecordings, initializeRecordingLedger } from '@/lib/recording-sync';
import { initializeRouteBuffer } from '@/lib/route-buffer';
import { mobileSupabaseConfigured } from '@/lib/runtime-config';
import { enforceMobileSessionPolicy } from '@/lib/session-policy';
import { supabase } from '@/lib/supabase';
import '@/lib/test-drive-tracking';
import { colors, font } from '@/theme';

export default function RootLayout() {
  useEffect(() => {
    if (!mobileSupabaseConfigured) return;
    initializeRouteBuffer();
    initializeRecordingLedger();
    // Call recordings sync when the app opens and each time it returns to the
    // foreground (best effort; failures stay in the ledger for the next run).
    const syncNow = () => void autoSyncRecordings().catch(() => undefined);
    syncNow();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') syncNow();
    });
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    if (!mobileSupabaseConfigured) return;

    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const checkSession = async () => {
      if (disposed) return;
      const policy = await enforceMobileSessionPolicy();
      if (disposed) return;
      if (expiryTimer) clearTimeout(expiryTimer);
      if (policy.expired) {
        router.replace('/');
        return;
      }
      if (policy.expiresAt) {
        expiryTimer = setTimeout(
          () => void checkSession(),
          Math.max(0, policy.expiresAt - Date.now()),
        );
      }
    };

    void checkSession();
    const appStateSubscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void checkSession();
    });
    const {
      data: { subscription: authSubscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        setTimeout(() => void checkSession(), 0);
      }
      if (event === 'SIGNED_IN')
        setTimeout(() => void autoSyncRecordings().catch(() => undefined), 0);
      if (event === 'SIGNED_OUT' && expiryTimer) clearTimeout(expiryTimer);
    });

    return () => {
      disposed = true;
      if (expiryTimer) clearTimeout(expiryTimer);
      appStateSubscription.remove();
      authSubscription.unsubscribe();
    };
  }, []);
  if (!mobileSupabaseConfigured) {
    return (
      <SafeAreaProvider>
        <SafeAreaView style={styles.safe}>
          <StatusBar style="dark" />
          <View style={styles.configurationCard}>
            <Text style={styles.title}>Mobile setup required</Text>
            <Text style={styles.body}>
              This build is missing its public Supabase configuration. Ask your administrator to
              restart or rebuild the app with the mobile environment configured.
            </Text>
          </View>
        </SafeAreaView>
      </SafeAreaProvider>
    );
  }
  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <ToastProvider>
          <CallFlowProvider>
            <StatusBar style="dark" />
            <Stack
              screenOptions={{
                headerShown: false,
                animation: 'slide_from_right',
                animationDuration: 220,
                freezeOnBlur: true,
                gestureEnabled: true,
                fullScreenGestureEnabled: true,
                contentStyle: { backgroundColor: colors.background },
              }}
            >
              <Stack.Screen name="index" options={{ animation: 'fade' }} />
              <Stack.Screen
                name="telecaller"
                options={{ animation: 'fade', gestureEnabled: false }}
              />
              <Stack.Screen name="sales" options={{ animation: 'fade', gestureEnabled: false }} />
            </Stack>
          </CallFlowProvider>
        </ToastProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  safe: {
    flex: 1,
    justifyContent: 'center',
    backgroundColor: colors.background,
    padding: 28,
  },
  configurationCard: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 18,
    backgroundColor: colors.onColor,
    padding: 24,
  },
  title: { color: colors.text, fontSize: font.display, fontWeight: '700' },
  body: { color: colors.muted, fontSize: font.row, lineHeight: 21, marginTop: 10 },
});
