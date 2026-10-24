import { CameraView, useCameraPermissions } from 'expo-camera';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Icon } from '@/components/ui/icon';
import { exchangeMobileLink } from '@/lib/mobile-link';
import { routeForCurrentSession } from '@/lib/session-route';
import { thud } from '@/motion/haptics';
import { colors, font } from '@/theme';

// The camera keeps running while the code is exchanged, so without a visible
// change people could not tell a scan had been read and kept aiming.
type Phase = 'scanning' | 'verifying' | 'linked' | 'failed';

const frameColor: Record<Phase, string> = {
  scanning: colors.onColor,
  verifying: colors.success,
  linked: colors.success,
  failed: colors.danger,
};

export default function LinkMobile() {
  const [permission, requestPermission] = useCameraPermissions();
  const [phase, setPhase] = useState<Phase>('scanning');
  const [error, setError] = useState<string>();
  // The scanner reports the same code several times a second; state updates
  // too late to stop the second exchange, so a ref gates it.
  const busy = useRef(false);
  async function scanned(data: string) {
    if (busy.current) return;
    busy.current = true;
    thud();
    setPhase('verifying');
    setError(undefined);
    try {
      const result = await exchangeMobileLink(data);
      setPhase('linked');
      const next = result.mfaRequired ? '/mfa' : await routeForCurrentSession();
      setTimeout(() => router.replace(next), 600);
    } catch (scanError) {
      setError(
        scanError instanceof Error && scanError.message === 'INVALID_MOBILE_LINK'
          ? 'This is not a Go Digital link code. Open Link Mobile App in your web profile and scan that QR.'
          : 'This code has expired or was already used. Create a new code from the web profile.',
      );
      setPhase('failed');
    }
  }
  const retry = () => {
    setError(undefined);
    setPhase('scanning');
    busy.current = false;
  };
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
        {/* CameraView takes no children; the frame sits over it instead. */}
        <View style={styles.camera}>
          <CameraView
            style={StyleSheet.absoluteFill}
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={phase === 'scanning' ? ({ data }) => void scanned(data) : undefined}
          />
          <View pointerEvents="none" style={[styles.frame, { borderColor: frameColor[phase] }]} />
          {phase !== 'scanning' ? (
            <View pointerEvents="none" style={styles.overlay}>
              {phase === 'verifying' ? (
                <ActivityIndicator size="large" color={colors.onColor} />
              ) : (
                <Icon
                  name={phase === 'linked' ? 'checkmark-circle' : 'close-circle'}
                  size={56}
                  color={phase === 'linked' ? colors.success : colors.danger}
                />
              )}
              <Text style={styles.overlayTitle}>
                {phase === 'verifying'
                  ? 'QR scanned'
                  : phase === 'linked'
                    ? 'Linked'
                    : 'Could not link'}
              </Text>
              {phase === 'verifying' ? (
                <Text style={styles.overlayText}>Verifying your account…</Text>
              ) : null}
            </View>
          ) : null}
        </View>
        <Text
          accessibilityLiveRegion="polite"
          style={[styles.status, phase === 'failed' && styles.error]}
        >
          {phase === 'scanning'
            ? 'Point the camera at the QR on your computer screen.'
            : phase === 'verifying'
              ? 'Keep the app open while we sign you in.'
              : phase === 'linked'
                ? 'Signed in. Opening your workspace…'
                : error}
        </Text>
        {phase === 'failed' ? (
          <Pressable style={[styles.primary, styles.retry]} onPress={retry}>
            <Text style={styles.primaryText}>Scan again</Text>
          </Pressable>
        ) : null}
        <Pressable onPress={() => router.back()} disabled={phase === 'verifying'}>
          <Text style={[styles.back, phase === 'verifying' && styles.muted]}>Cancel</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, justifyContent: 'center', padding: 28, alignItems: 'center' },
  content: { flex: 1, padding: 22 },
  title: { color: colors.text, fontSize: font.display, fontWeight: '700' },
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
    backgroundColor: colors.scrim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  frame: { width: 230, height: 230, borderWidth: 3, borderRadius: 18 },
  overlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  overlayTitle: { color: colors.onColor, fontSize: font.heading, fontWeight: '700' },
  overlayText: { color: colors.onColor, fontSize: font.body },
  primary: {
    backgroundColor: colors.primary,
    borderRadius: 12,
    padding: 15,
    alignItems: 'center',
    alignSelf: 'stretch',
  },
  primaryText: { color: colors.onColor, fontWeight: '600' },
  back: { color: colors.primary, fontWeight: '700', textAlign: 'center', marginTop: 20 },
  status: { color: colors.muted, textAlign: 'center', lineHeight: 18, marginTop: 16 },
  error: { color: colors.danger, fontWeight: '600' },
  retry: { marginTop: 16 },
  muted: { opacity: 0.4 },
});
