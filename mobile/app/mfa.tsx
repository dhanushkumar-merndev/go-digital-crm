import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, SafeAreaView, StyleSheet, Text, TextInput, View } from 'react-native';
import { routeForCurrentSession } from '@/lib/session-route';
import { supabase } from '@/lib/supabase';
import { colors } from '@/theme';

export default function MfaScreen() {
  const [factorId, setFactorId] = useState<string>();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  useEffect(() => {
    void supabase.auth.mfa.listFactors().then(({ data }) => {
      const factor = data?.totp.find((item) => item.status === 'verified');
      if (factor) setFactorId(factor.id);
      else setError('Enroll TOTP from the web application before using this account on mobile.');
    });
  }, []);
  async function verify() {
    if (!factorId || code.length !== 6) return;
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
      code,
    });
    if (verifyError) {
      setError('The code was not accepted. Wait for a new code and try again.');
      return;
    }
    router.replace(await routeForCurrentSession());
  }
  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.content}>
        <Text style={styles.title}>Authenticator verification</Text>
        <Text style={styles.body}>
          Enter the current 6-digit code from your enrolled authenticator app.
        </Text>
        <TextInput
          style={styles.input}
          value={code}
          onChangeText={(value) => setCode(value.replace(/\D/g, '').slice(0, 6))}
          keyboardType="number-pad"
          autoComplete="one-time-code"
          maxLength={6}
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Pressable style={styles.primary} onPress={() => void verify()}>
          <Text style={styles.primaryText}>Verify and continue</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  content: { flex: 1, justifyContent: 'center', padding: 28 },
  title: { color: colors.text, fontSize: 25, fontWeight: '800' },
  body: { color: colors.muted, lineHeight: 20, marginTop: 8, marginBottom: 24 },
  input: {
    height: 58,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: 'white',
    borderRadius: 12,
    paddingHorizontal: 14,
    color: colors.text,
    fontSize: 24,
    letterSpacing: 12,
    textAlign: 'center',
  },
  error: { color: colors.danger, fontSize: 12, lineHeight: 18, marginTop: 12 },
  primary: {
    backgroundColor: colors.primary,
    borderRadius: 12,
    padding: 15,
    alignItems: 'center',
    marginTop: 18,
  },
  primaryText: { color: 'white', fontWeight: '800' },
});
