import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';
import { PrimaryButton } from '@/components/ui/basics';
import { Icon } from '@/components/ui/icon';
import { PressableScale } from '@/components/ui/pressable-scale';
import { routeForCurrentSession } from '@/lib/session-route';
import { mobileSupabaseConfigured } from '@/lib/runtime-config';
import { supabase } from '@/lib/supabase';
import { colors, font, radius, space } from '@/theme';

const logo = require('../assets/logo.png');

export default function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  // A saved session goes straight to the role's home; without this every app
  // restart asked for the password again.
  const [restoring, setRestoring] = useState(mobileSupabaseConfigured);
  useEffect(() => {
    if (!mobileSupabaseConfigured) return;
    let active = true;
    void (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        if (data.session) {
          const destination = await routeForCurrentSession();
          if (active) router.replace(destination);
          return;
        }
      } catch {
        // Expired or ineligible sessions fall through to the sign-in form.
      }
      if (active) setRestoring(false);
    })();
    return () => {
      active = false;
    };
  }, []);
  async function signIn() {
    if (!mobileSupabaseConfigured) {
      setError('Mobile setup is incomplete. Restart the app after configuring its environment.');
      return;
    }
    if (!email.trim() || !password) {
      setError('Enter your work email and password.');
      return;
    }
    setLoading(true);
    setError(undefined);
    try {
      const { error: authError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (authError) {
        setError('Sign-in failed. Check your email, password, and internet connection.');
        return;
      }
      try {
        router.replace(await routeForCurrentSession());
      } catch {
        setError('Your account is not eligible for the mobile app.');
      }
    } catch {
      setError('The sign-in service could not be reached. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }
  if (restoring) {
    return (
      <SafeAreaView style={[styles.safe, styles.restoring]}>
        <Image source={logo} style={styles.logoLarge} accessibilityLabel="Go Digital" />
        <ActivityIndicator color={colors.primary} />
      </SafeAreaView>
    );
  }
  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView behavior="padding" style={styles.content}>
        <Animated.View entering={FadeIn.duration(220)}>
          <Image source={logo} style={styles.logo} accessibilityLabel="Go Digital" />
          <Text style={styles.title}>Welcome back</Text>
          <Text style={styles.subtitle}>Sign in to your Go Digital work account.</Text>
        </Animated.View>
        <Animated.View entering={FadeIn.delay(60).duration(220)} style={styles.form}>
          <View style={styles.field}>
            <Icon name="mail-outline" size={20} color={colors.muted} />
            <TextInput
              style={styles.input}
              value={email}
              onChangeText={setEmail}
              placeholder="Work email"
              placeholderTextColor={colors.faint}
              autoCapitalize="none"
              keyboardType="email-address"
              autoComplete="email"
              returnKeyType="next"
            />
          </View>
          <View style={styles.field}>
            <Icon name="lock-closed-outline" size={20} color={colors.muted} />
            <TextInput
              style={styles.input}
              value={password}
              onChangeText={setPassword}
              placeholder="Password"
              placeholderTextColor={colors.faint}
              secureTextEntry={!showPassword}
              autoComplete="current-password"
              returnKeyType="go"
              onSubmitEditing={() => void signIn()}
            />
            <PressableScale
              onPress={() => setShowPassword((value) => !value)}
              hitSlop={10}
              accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
            >
              <Icon
                name={showPassword ? 'eye-off-outline' : 'eye-outline'}
                size={20}
                color={colors.muted}
              />
            </PressableScale>
          </View>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <PrimaryButton label="Sign in" busy={loading} onPress={() => void signIn()} />
          <View style={styles.or}>
            <View style={styles.rule} />
            <Text style={styles.orText}>or</Text>
            <View style={styles.rule} />
          </View>
          <PrimaryButton
            label="Scan QR from web"
            icon="qr-code-outline"
            variant="secondary"
            onPress={() => router.push('/link-mobile')}
          />
        </Animated.View>
        <Text style={styles.note}>For Telecaller and Sales Consultant accounts.</Text>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  restoring: { alignItems: 'center', justifyContent: 'center', gap: space.xl },
  content: { flex: 1, justifyContent: 'center', padding: space.xl },
  logo: { width: 64, height: 64, marginBottom: 24 },
  logoLarge: { width: 96, height: 96 },
  title: {
    fontSize: font.hero,
    fontWeight: '600',
    letterSpacing: -0.6,
    color: colors.text,
    marginTop: space.xl,
  },
  subtitle: { fontSize: font.body, color: colors.muted, marginTop: 6 },
  form: { gap: space.md, marginTop: space.xl },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    height: 54,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
  },
  input: { flex: 1, color: colors.text, fontSize: font.heading, paddingVertical: 0 },
  error: { color: colors.danger, fontSize: font.small, fontWeight: '600' },
  or: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  rule: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  orText: { color: colors.faint, fontSize: font.label, fontWeight: '700' },
  note: { color: colors.faint, fontSize: font.label, textAlign: 'center', marginTop: space.xl },
});
