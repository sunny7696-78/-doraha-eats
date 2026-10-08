/**
 * Push notifications (Expo push service -> FCM on Android).
 *
 * Registers this phone's Expo push token with the backend after login so the server can alert
 * vendors (new order), riders (new delivery) and customers (order updates). It must NEVER break
 * the app: if the user declines permission, runs a build without Firebase configured, or is on a
 * simulator, we just skip silently and the app keeps working through polling.
 */
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { api } from '../../lib/api';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false,
  }),
});

export async function registerForPush(): Promise<void> {
  try {
    if (Platform.OS === 'web' || !Device.isDevice) return;

    if (Platform.OS === 'android') {
      // The server sends every push with channelId 'orders' (adapters/push). The channel must exist
      // with HIGH importance or Android shows the alert silently, without a pop-up or sound.
      await Notifications.setNotificationChannelAsync('orders', {
        name: 'Orders', importance: Notifications.AndroidImportance.HIGH, sound: 'default', vibrationPattern: [0, 250, 250, 250],
      });
    }

    let { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
    if (status !== 'granted') return;

    const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;
    if (!projectId) return;

    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    await api('/auth/device-token', {
      method: 'POST', body: { token, platform: Platform.OS === 'ios' ? 'ios' : 'android' },
    });
  } catch {
    // No Firebase credentials in this build, offline, etc. Polling still works.
  }
}
