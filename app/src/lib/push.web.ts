/** The web build has no Expo push: the phone is what gets notified. */
export async function registerForPush(_api: <T>(path: string, init?: { method?: string; body?: unknown }) => Promise<T>): Promise<void> {}

export function followNotificationTaps(): () => void {
  return () => {};
}
