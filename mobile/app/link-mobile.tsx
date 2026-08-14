import { CameraView, useCameraPermissions } from 'expo-camera';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { exchangeMobileLink } from '@/lib/mobile-link';
import { routeForCurrentSession } from '@/lib/session-route';
import { colors } from '@/theme';

export default function LinkMobile() {
  const [permission, requestPermission] = useCameraPermissions();
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string>();
  async function scanned(data: string) {
    if (processing) return;
    setProcessing(true);
    setError(undefined);
    try {
      const result = await exchangeMobileLink(data);
      router.replace(result.mfaRequired ? '/mfa' : await routeForCurrentSession());
    } catch {
      setError(
        'This QR code is invalid, expired, or already used. Create a new code from the web profile.',
      );
      setProcessing(false);
    }
  }
  if (!permission?.granted)
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.center}>
          <Text style={styles.title}>Camera access required</Text>
          <Text style={styles.body}>
            Camera access is used only to scan the short-lived one-time linking QR.
          </Text>
          <Pressable style={styles.primary} onPress={() => void requestPermission()}>
            <Text style={styles.primaryText}>Allow camera</Text>
          </Pressable>
          <Pressable onPress={() => router.back()}>
            <Text style={styles.back}>Cancel</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.content}>
        <Text style={styles.title}>Link mobile app</Text>
        <Text style={styles.body}>Scan the QR shown in your authenticated web profile.</Text>
        <CameraView
          style={styles.camera}
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => void scanned(data)}
        >
          <View style={styles.frame} />
        </CameraView>
        {processing ? <Text style={styles.status}>Linking securely…</Text> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Pressable onPress={() => router.back()}>
          <Text style={styles.back}>Cancel</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, justifyContent: 'center', padding: 28, alignItems: 'center' },
  content: { flex: 1, padding: 22 },
  title: { color: colors.text, fontSize: 24, fontWeight: '800' },
  body: {
    color: colors.muted,
    textAlign: 'center',
    lineHeight: 20,
    marginTop: 8,
    marginBottom: 22,
  },
  camera: {
    height: 420,
    borderRadius: 18,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  frame: { width: 230, height: 230, borderWidth: 3, borderColor: 'white', borderRadius: 18 },
  primary: {
    backgroundColor: colors.primary,
    borderRadius: 12,
    padding: 15,
    alignItems: 'center',
    alignSelf: 'stretch',
  },
  primaryText: { color: 'white', fontWeight: '800' },
  back: { color: colors.primary, fontWeight: '700', textAlign: 'center', marginTop: 20 },
  status: { color: colors.primary, textAlign: 'center', fontWeight: '700', marginTop: 16 },
  error: { color: colors.danger, textAlign: 'center', lineHeight: 18, marginTop: 16 },
});
