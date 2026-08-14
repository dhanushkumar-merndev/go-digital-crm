import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { initializeRouteBuffer } from '@/lib/route-buffer';

export default function RootLayout() {
  useEffect(() => initializeRouteBuffer(), []);
  return (
    <>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false }} />
    </>
  );
}
