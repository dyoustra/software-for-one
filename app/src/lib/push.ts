import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

/**
 * Asks to notify, and gives the control plane this phone's push token, so a
 * run stopping for the person reaches them. Quietly does nothing in a
 * simulator, without permission, or before the app is linked to EAS.
 */
export async function registerForPush(api: <T>(path: string, init?: { method?: string; body?: unknown }) => Promise<T>): Promise<void> {
  if (!Device.isDevice) return;
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== 'granted') return;
  const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
  if (!projectId) return;
  const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
  // The control plane pushes a one-time code to this token and uses it only
  // once the code comes back: proof this phone receives on it.
  const received = Notifications.addNotificationReceivedListener((n) => {
    const code = n.request.content.data?.sfoVerify;
    if (typeof code === 'string') {
      api('/push-tokens/verify', { method: 'POST', body: { token: data, code } }).catch(() => undefined);
      received.remove();
    }
  });
  setTimeout(() => received.remove(), 60_000);
  await api('/push-tokens', { method: 'POST', body: { token: data } });
}

function open(response: Notifications.NotificationResponse | null): void {
  const projectId = response?.notification.request.content.data?.projectId;
  if (typeof projectId === 'string') router.push({ pathname: '/project/[id]', params: { id: projectId } });
}

/** A tap on a notification opens its project — including the tap that launched the app. */
export function followNotificationTaps(): () => void {
  open(Notifications.getLastNotificationResponse());
  const subscription = Notifications.addNotificationResponseReceivedListener(open);
  return () => subscription.remove();
}
