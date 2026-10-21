import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import Animated, {
  FadeIn,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';
import { PrimaryButton } from '@/components/ui/basics';
import { Icon } from '@/components/ui/icon';
import { routeForCurrentSession } from '@/lib/session-route';
import { supabase } from '@/lib/supabase';
import { thud } from '@/motion/haptics';
import { colors, font, radius, space } from '@/theme';

const DIGITS = 6;

export default function MfaScreen() {
  const [factorId, setFactorId] = useState<string>();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const input = useRef<TextInput>(null);
  const shake = useSharedValue(0);
  const shaking = useAnimatedStyle(() => ({ transform: [{ translateX: shake.value }] }));
  useEffect(() => {
    void supabase.auth.mfa.listFactors().then(({ data }) => {
      const factor = data?.totp.find((item) => item.status === 'verified');
      if (factor) setFactorId(factor.id);
      else setError('Enroll TOTP from the web application before using this account on mobile.');
    });
  }, []);
  async function verify(value: string) {
    if (!factorId || value.length !== DIGITS || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({
        factorId,
      });
      if (challengeError) {
        setError(challengeError.message);
        return;
      }
      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId,
        challengeId: challenge.id,
        code: value,
      });
      if (verifyError) {
        thud();
        shake.value = withSequence(
          withTiming(-10, { duration: 50 }),
          withTiming(10, { duration: 50 }),
          withTiming(-6, { duration: 50 }),
          withTiming(0, { duration: 50 }),
        );
        setCode('');
        setError('That code was not accepted. Wait for a new code and try again.');
        return;
      }
      router.replace(await routeForCurrentSession());
    } finally {
      setBusy(false);
    }
  }
  return (
    <SafeAreaView style={styles.safe}>
      <Animated.View entering={FadeIn.duration(220)} style={styles.content}>
        <View style={styles.icon}>
          <Icon name="shield-checkmark" size={30} color={colors.primary} />
        </View>
        <Text style={styles.title}>Enter your code</Text>
        <Text style={styles.body}>Open your authenticator app and type the 6-digit code.</Text>
        <Pressable onPress={() => input.current?.focus()} accessibilityLabel="Verification code">
          <Animated.View style={[styles.boxes, shaking]}>
            {Array.from({ length: DIGITS }, (_, index) => (
              <View
                key={index}
                style={[
                  styles.box,
                  index === code.length && styles.boxActive,
                  error && !code ? styles.boxError : null,
                ]}
              >
                <Text style={styles.digit}>{code[index] ?? ''}</Text>
              </View>
            ))}
          </Animated.View>
        </Pressable>
        <TextInput
          ref={input}
          autoFocus
          value={code}
          onChangeText={(value) => {
            const next = value.replace(/\D/g, '').slice(0, DIGITS);
            setCode(next);
            if (next.length === DIGITS) void verify(next);
          }}
          keyboardType="number-pad"
          autoComplete="one-time-code"
          textContentType="oneTimeCode"
          maxLength={DIGITS}
          style={styles.hidden}
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <PrimaryButton
          label="Verify"
          busy={busy}
          disabled={code.length !== DIGITS}
          onPress={() => void verify(code)}
        />
      </Animated.View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  content: { flex: 1, justifyContent: 'center', padding: space.xl, gap: space.md },
  icon: {
    width: 60,
    height: 60,
    borderRadius: 18,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { color: colors.text, fontSize: font.hero, fontWeight: '700', letterSpacing: -0.5 },
  body: { color: colors.muted, fontSize: font.body, lineHeight: 21 },
  boxes: { flexDirection: 'row', justifyContent: 'space-between', marginVertical: space.md },
  box: {
    width: 48,
    height: 58,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxActive: { borderColor: colors.primary },
  boxError: { borderColor: colors.danger },
  digit: { color: colors.text, fontSize: font.display, fontWeight: '700' },
  hidden: { position: 'absolute', opacity: 0, width: 1, height: 1 },
  error: { color: colors.danger, fontSize: font.small, fontWeight: '600', lineHeight: 19 },
});
