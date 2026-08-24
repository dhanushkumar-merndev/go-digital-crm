import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { initializeRouteBuffer } from '@/lib/route-buffer';
import { mobileSupabaseConfigured } from '@/lib/runtime-config';
import '@/lib/test-drive-tracking';
import { colors } from '@/theme';

export default function RootLayout() {
  useEffect(() => {
    if (mobileSupabaseConfigured) initializeRouteBuffer();
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
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false }} />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
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
    backgroundColor: 'white',
    padding: 24,
  },
  title: { color: colors.text, fontSize: 24, fontWeight: '800' },
  body: { color: colors.muted, fontSize: 14, lineHeight: 21, marginTop: 10 },
});
