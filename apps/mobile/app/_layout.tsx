import React, { useEffect } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { useAuthStore } from '../src/store/authStore';
import { View, ActivityIndicator } from 'react-native';
import { colors } from '../src/theme/tokens';

/**
 * A single Expo binary, three role-scoped route groups. This layout branches
 * on the logged-in user's role so a customer, a stall owner and a rider all
 * land in the right place from one app — see the mobile design doc for why.
 */
import { registerForPush } from '../src/features/push/register';

function RootNavigation() {
  const { user, token, hydrated, hydrate } = useAuthStore();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => { hydrate(); }, []);

  // Once someone is logged in, register this phone for order alerts.
  const loggedInUserId = user?.id;
  useEffect(() => { if (hydrated && loggedInUserId && token) registerForPush(); }, [hydrated, loggedInUserId, token]);

  useEffect(() => {
    if (!hydrated) return;
    const group = segments[0];
    const loggedIn = !!user && !!token;

    if (!loggedIn && group !== '(onboarding)') {
      router.replace('/(onboarding)/login');
      return;
    }
    if (loggedIn) {
      const expected =
        user!.role === 'VENDOR' ? '(vendor)' : user!.role === 'DELIVERY' ? '(rider)' : '(customer)';
      if (group !== expected) router.replace(expected === '(vendor)' ? '/(vendor)' : expected === '(rider)' ? '/(rider)' : '/(customer)/(tabs)');
    }
  }, [hydrated, user, token, segments]);

  if (!hydrated) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background }}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(onboarding)" />
      <Stack.Screen name="(customer)" />
      <Stack.Screen name="(vendor)" />
      <Stack.Screen name="(rider)" />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <RootNavigation />
    </SafeAreaProvider>
  );
}
