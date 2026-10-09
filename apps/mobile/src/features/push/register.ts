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
import { usePushStatus } from './status';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false,
  }),
});

export async function registerForPush(): Promise<void> {
  const report = usePushStatus.getState().set;
  try {
    if (Platform.OS === 'web') return report('not available on web');
    if (!Device.isDevice) return report('not available on an emulator');

    if (Platform.OS === 'android') {
      // The server sends every push with channelId 'orders' (adapters/push). The channel must exist
      // with HIGH importance or Android shows the alert silently, without a pop-up or sound.
      await Notifications.setNotificationChannelAsync('orders', {
        name: 'Orders', importance: Notifications.AndroidImportance.HIGH, sound: 'default', vibrationPattern: [0, 250, 250, 250],
      });
    }

    let { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
    if (status !== 'granted') return report('OFF - notifications are blocked. Turn them on in phone Settings > Apps > Doraha Eats > Notifications');

    const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;
    if (!projectId) return report('OFF - app build has no project id');

    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    await api('/auth/device-token', {
      method: 'POST', body: { token, platform: Platform.OS === 'ios' ? 'ios' : 'android' },
    });
    report('ON');
  } catch (e) {
    // Never break the app (polling still works) - but say WHY, so it can be fixed.
    report(`OFF - ${(e as Error)?.message?.slice(0, 140) || 'unknown error'}`);
  }
}
