import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, SafeAreaView, StyleSheet, Text, TextInput, View } from 'react-native';
import { routeForCurrentSession } from '@/lib/session-route';
import { supabase } from '@/lib/supabase';
import { colors } from '@/theme';

export default function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  async function signIn() {
    setLoading(true);
    setError(undefined);
    const { error: authError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    if (authError) {
      setError(authError.message);
      setLoading(false);
      return;
    }
    try {
      router.replace(await routeForCurrentSession());
    } catch {
      setError('Your account is not eligible for the mobile app.');
    } finally {
      setLoading(false);
    }
  }
  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.content}>
        <View style={styles.logo}>
          <Text style={styles.logoText}>GO</Text>
        </View>
        <Text style={styles.title}>Go Digital Marketing CRM</Text>
        <Text style={styles.subtitle}>
          Sign in with your verified work email or link this app from your authenticated web
          profile.
        </Text>
        <Text style={styles.label}>WORK EMAIL</Text>
        <TextInput
          style={styles.input}
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
          autoComplete="email"
        />
        <Text style={styles.label}>PASSWORD</Text>
        <TextInput
          style={styles.input}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoComplete="current-password"
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Pressable style={styles.primary} disabled={loading} onPress={() => void signIn()}>
          <Text style={styles.primaryText}>{loading ? 'Signing in…' : 'Sign in'}</Text>
        </Pressable>
        <Pressable style={styles.secondary} onPress={() => router.push('/link-mobile')}>
          <Text style={styles.secondaryText}>Scan web linking QR</Text>
        </Pressable>
        <Text style={styles.note}>
          Only Telecaller / BDC and Sales Consultant workflows are available in the mobile MVP.
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  content: { flex: 1, justifyContent: 'center', padding: 28 },
  logo: {
    width: 56,
    height: 56,
    borderRadius: 16,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoText: { color: 'white', fontWeight: '900' },
  title: { fontSize: 27, fontWeight: '800', color: colors.text, marginTop: 22 },
  subtitle: { fontSize: 14, lineHeight: 21, color: colors.muted, marginTop: 8, marginBottom: 24 },
  label: { color: colors.muted, fontSize: 10, fontWeight: '800', marginBottom: 6, marginTop: 12 },
  input: {
    height: 48,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: 'white',
    borderRadius: 12,
    paddingHorizontal: 13,
    color: colors.text,
  },
  error: { color: colors.danger, fontSize: 12, marginTop: 12 },
  primary: {
    backgroundColor: colors.primary,
    borderRadius: 12,
    padding: 15,
    alignItems: 'center',
    marginTop: 18,
  },
  primaryText: { color: 'white', fontWeight: '800' },
  secondary: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: 'white',
    borderRadius: 12,
    padding: 15,
    alignItems: 'center',
    marginTop: 12,
  },
  secondaryText: { color: colors.text, fontWeight: '800' },
  note: { color: colors.muted, fontSize: 11, lineHeight: 17, textAlign: 'center', marginTop: 22 },
});
